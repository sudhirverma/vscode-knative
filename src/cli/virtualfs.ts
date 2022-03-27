/* eslint-disable @typescript-eslint/no-unused-vars */
// Copied from https://github.com/Azure/vscode-kubernetes-tools/blob/master/src/kuberesources.virtualfs.ts

/*-----------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE file in the project root for license information.
 *-----------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as querystring from 'querystring';
import {
  Disposable,
  Event,
  EventEmitter,
  FileChangeEvent,
  FileChangeType,
  FileStat,
  FileSystemProvider,
  FileType,
  Uri,
  window,
} from 'vscode';
import * as fsx from 'fs-extra';
import * as yaml from 'yaml';
import { CliExitData, execCmdCli } from './cmdCli';
import * as config from './config';
import { Execute } from './execute';
import { KnAPI } from './kn-api';
import { VFSFileStat } from './vfs-file-stat';
import { registerSchema } from '../editor/knativeSchemaRegister';
import { Errorable } from '../util/errorable';

export const KN_RESOURCE_SCHEME = 'knmsx';
export const KN_RESOURCE_AUTHORITY = 'loadknativecore';

export function vfsUri(
  schema: string,
  contextValue: string,
  name: string,
  outputFormat: string,
  namespace?: string | null | undefined /* TODO: rationalize null and undefined */,
): Uri {
  const c1 = contextValue.replace('/', '-');
  const context = c1.replace('.', '-');
  const docName = `${context}-${name}.${outputFormat}`;
  const nonce = new Date().getTime();
  const nsQuery = namespace ? `ns=${namespace}&` : '';
  // "knmsx://loadknativecore/serviceKnative-tutorial-greeter.yaml?contextValue=service&name=knative-tutorial-greeter&_=1593030763939"
  const uri = `${schema}://${KN_RESOURCE_AUTHORITY}/${docName}?${nsQuery}contextValue=${context}&name=${name}&_=${nonce}`;
  return Uri.parse(uri);
}

export class KnativeResourceVirtualFileSystemProvider implements FileSystemProvider {
  private readonly onDidChangeFileEmitter: EventEmitter<FileChangeEvent[]> = new EventEmitter<FileChangeEvent[]>();

  onDidChangeFile: Event<FileChangeEvent[]> = this.onDidChangeFileEmitter.event;

  private fileStats = new Map<string, VFSFileStat>();

  public knExecutor = new Execute();

  // eslint-disable-next-line class-methods-use-this
  watch(): Disposable {
    return new Disposable(() => true);
  }

  stat(uri: Uri): FileStat | Thenable<FileStat> {
    return this.ensureStat(uri);
  }

  private ensureStat(uri: Uri): VFSFileStat {
    if (!this.fileStats.has(uri.toString())) {
      this.fileStats.set(uri.toString(), new VFSFileStat());
    }

    const stat = this.fileStats.get(uri.toString());
    stat.changeStat(stat.size + 1);

    return stat;
  }

  readFile(uri: Uri): Uint8Array | Thenable<Uint8Array> {
    return this.readFileAsync(uri);
  }

  async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
    const tempPath = os.tmpdir();
    const fsPath = path.join(tempPath, uri.fsPath);
    await fsx.ensureFile(fsPath);
    await fsx.writeFile(fsPath, content);
    await this.updateK8sResource(fsPath);
    if (fsPath) {
      const oldStat = await fsx.stat(fsPath);
      await fsx.unlink(fsPath);

      // Use timeout to fire file change event in another event loop cycle, this will cause update content inside editor
      setTimeout(() => {
        this.fileStats.get(uri.toString())?.changeStat(oldStat.size + 1); // change stat to ensure content update
        this.onDidChangeFileEmitter.fire([{ uri, type: FileChangeType.Changed }]);
      }, 10);
    }
  }

  // eslint-disable-next-line class-methods-use-this
  async updateK8sResource(fsPath: string): Promise<void> {
    try {
      // push the updated YAML back to the cluster
      const result: CliExitData = await execCmdCli.execute(KnAPI.applyYAML(fsPath, { override: false }));
      // Delete the yaml that was pushed if there was no error
      if (result.error) {
        // eslint-disable-next-line no-console, @typescript-eslint/restrict-template-expressions
        console.log(`updateServiceFromYaml result.error = ${result.error}`);
        await fsx.unlink(fsPath);
        // deal with the error that is passed on but not thrown by the Promise.
        throw result.error;
      }
    } catch (error) {
      if (typeof error === 'string' && error.search('validation failed') > 0) {
        // eslint-disable-next-line @typescript-eslint/prefer-string-starts-ends-with
        const fileName = error.slice(error.lastIndexOf('validation failed:'));
        // eslint-disable-next-line no-console
        console.log(`The YAMl file failed validation with the following error.\n\n${fileName}`);
      } else if (
        typeof error === 'string' &&
        (error.search(/undefinedWarning/gm) >= 0 || error.search(/undefined.+Warning/gm) >= 0)
      ) {
        // eslint-disable-next-line no-console
        console.log(`updateServiceFromYaml undefinedWarning; error = ${error}`);
        // do nothing it was a warning
      } else {
        // eslint-disable-next-line no-console, @typescript-eslint/restrict-template-expressions
        console.log(`updateServiceFromYaml error = ${error}`);
        await window.showErrorMessage(`There was an error while uploading the YAML. `, { modal: true }, 'OK');
      }
      await fsx.unlink(fsPath);
    }
  }

  // eslint-disable-next-line class-methods-use-this
  readDirectory(_uri: Uri): [string, FileType][] | Thenable<[string, FileType][]> {
    return []; // no-op
  }

  // eslint-disable-next-line class-methods-use-this
  createDirectory(_uri: Uri): void | Thenable<void> {
    // no-op
  }

  async readFileAsync(uri: Uri): Promise<Uint8Array> {
    await registerSchema();

    const content = await this.loadResource(uri);
    return Buffer.from(content, 'utf8');
  }

  async loadResource(uri: Uri): Promise<string> {
    const query = querystring.parse(uri.query);

    const outputFormat = config.getOutputFormat();
    const contextValue = query.contextValue as string;
    const context = contextValue === 'revision_tagged' ? 'revision' : contextValue;
    const name = query.name as string;
    const ns = query.ns as string | undefined;
    const resourceAuthority = uri.authority;
    const eced = await this.execLoadResource(uri.scheme, resourceAuthority, ns, context, name, outputFormat);

    if (Errorable.failed(eced)) {
      await window.showErrorMessage(eced.error[0]);
      throw eced.error[0];
    }

    const ced = eced.result;

    return ced.stdout;
  }

  async execLoadResource(
    scheme: string,
    resourceAuthority: string,
    ns: string | undefined,
    contextValue: string,
    name: string,
    outputFormat: string,
  ): Promise<Errorable<CliExitData>> {
    let ced: CliExitData;
    let cleanedCed: CliExitData;
    const feature: string = contextValue.includes('_') ? contextValue.substr(0, contextValue.indexOf('_')) : contextValue;
    const sourceType: string =
      // eslint-disable-next-line prefer-template
      contextValue.includes('_') && feature === 'source' ? ' ' + contextValue.substr(contextValue.indexOf('_') + 1) : '';
    const command = feature + sourceType;
    switch (resourceAuthority) {
      case KN_RESOURCE_AUTHORITY:
        // fetch the YAML output
        ced = await execCmdCli.execute(KnAPI.describeFeature(command, name, outputFormat));
        if (contextValue === 'service' && scheme === KN_RESOURCE_SCHEME) {
          cleanedCed = this.removeServerSideYamlElements(ced);
        } else {
          cleanedCed = ced;
        }
        return { succeeded: true, result: cleanedCed };
      default:
        return {
          succeeded: false,
          error: [
            `Internal error: please raise an issue with the error code InvalidObjectLoadURI and report authority ${resourceAuthority}.`,
          ],
        };
    }
  }

  // eslint-disable-next-line class-methods-use-this
  removeServerSideYamlElements(ced: CliExitData): CliExitData {
    if (ced.error) {
      return ced;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const doc = yaml.parse(ced.stdout);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    delete doc.metadata.creationTimestamp;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    delete doc.metadata.generation;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    delete doc.metadata.managedFields;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    delete doc.metadata.resourceVersion;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    delete doc.metadata.selfLink;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    delete doc.metadata.uid;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    delete doc.spec.template.metadata;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    delete doc.status;

    const cleanStdout = yaml.stringify(doc);
    const cleanCED: CliExitData = { error: ced.error, stdout: cleanStdout };
    return cleanCED;
  }

  // eslint-disable-next-line class-methods-use-this
  delete(uri: Uri, _options: { recursive: boolean }): void | Thenable<void> {
    // no-op
  }

  // eslint-disable-next-line class-methods-use-this
  rename(_oldUri: Uri, _newUri: Uri, _options: { overwrite: boolean }): void | Thenable<void> {
    // no-op
  }
}
