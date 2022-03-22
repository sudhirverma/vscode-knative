/* eslint-disable @typescript-eslint/no-unused-vars */
// Copied from https://github.com/Azure/vscode-kubernetes-tools/blob/master/src/kuberesources.virtualfs.ts

/*-----------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE file in the project root for license information.
 *-----------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
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
  workspace,
  WorkspaceFolder,
} from 'vscode';
import * as yaml from 'yaml';
import { CliExitData } from './cmdCli';
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

export async function showWorkspaceFolderPick(): Promise<WorkspaceFolder | undefined> {
  if (!workspace.workspaceFolders) {
    await window.showErrorMessage('This command requires an open Workspace folder.', { modal: true }, 'OK');
    return undefined;
  }
  if (workspace.workspaceFolders.length === 1) {
    return workspace.workspaceFolders[0];
  }
  return window.showWorkspaceFolderPick();
}

export async function selectRootFolder(): Promise<string | undefined> {
  const folder = await showWorkspaceFolderPick();
  if (!folder) {
    return undefined;
  }
  if (folder.uri.scheme !== 'file') {
    await window.showErrorMessage('This command requires a filesystem folder'); // TODO: make it not
    return undefined;
  }
  return folder.uri.fsPath;
}

export async function saveAsync(uri: Uri, content: Uint8Array, subFolder?: string): Promise<void> {
  const rootPath = await selectRootFolder();
  if (!rootPath) {
    return;
  }
  if (!uri.fsPath.startsWith(`${path.sep}revision`)) {
    const fspath = path.join(rootPath, subFolder || '', uri.fsPath);
    fs.writeFileSync(fspath, content);
  }
}

/**
 * Build a `path` based on the root folder and the arguments passed in.
 * @param subFolder
 * @param fileName
 * @returns `Promise<string>` of the path generated
 */
export async function getFilePathAsync(subFolder?: string, fileName?: string): Promise<string> {
  const rootPath = await selectRootFolder();
  if (!rootPath) {
    return;
  }
  const fspath = path.join(rootPath, subFolder || '', fileName || '');
  return fspath;
}

export class KnativeResourceVirtualFileSystemProvider implements FileSystemProvider {
  private readonly onDidChangeFileEmitter: EventEmitter<FileChangeEvent[]> = new EventEmitter<FileChangeEvent[]>();

  onDidChangeFile: Event<FileChangeEvent[]> = this.onDidChangeFileEmitter.event;

  private fileStats = new Map<string, VFSFileStat>();

  private yamlDirName = '.knative';

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

  writeFile(uri: Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean }): void | Thenable<void> {
    const s = saveAsync(uri, content, this.yamlDirName); // TODO: respect options
    this.onDidChangeFileEmitter.fire([{ type: FileChangeType.Created, uri }]);
    return s;
  }

  // eslint-disable-next-line class-methods-use-this
  readDirectory(_uri: Uri): [string, FileType][] | Thenable<[string, FileType][]> {
    return []; // no-op
  }

  // eslint-disable-next-line class-methods-use-this
  createDirectory(_uri: Uri): void | Thenable<void> {
    // no-op
  }

  /**
   * Add the directory if missing.
   *
   * Return an array of the array of `[path, fileType]` for the files in the dir.
   */
  async readDirectoryAsync(): Promise<[string, FileType][]> {
    const files: [string, FileType][] = [];
    await this.createDirectoryAsync(null);
    const dir = await getFilePathAsync(this.yamlDirName, null);
    fs.readdirSync(dir).forEach((localFile) => {
      files.push([path.join(dir, localFile), FileType.File]);
    });
    return files;
  }

  /**
   * If directory does not already exist, create it.
   * @param _uri Ignored. May be used in the future.
   */
  async createDirectoryAsync(_uri: Uri): Promise<void> {
    const dir = await getFilePathAsync(this.yamlDirName, null);

    // eslint-disable-next-line no-useless-catch
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      // console.log(`Error while createDirectoryAsync() ${err}`);
      throw err;
    }
  }

  async readFileAsync(uri: Uri): Promise<Uint8Array> {
    // await this.createDirectory(uri);
    // Check if there is an edited local version.
    // TODO: Check if the version on the cluster is newer,
    // Then if it is, ask the user if they want to replace the edited version.
    // const localFile = await getFilePathAsync(this.yamlDirName, uri.fsPath);

    await registerSchema();

    // (example) localFile = "/home/josh/git/vscode-extension-samples/basic-multi-root-sample/.knative/service-example.yaml"
    // if (fs.existsSync(localFile)) {
    //   // use local file
    //   const localContent = fs.readFileSync(localFile, { encoding: 'utf8' });
    //   return Buffer.from(localContent, 'utf8');
    // }
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
        ced = await this.knExecutor.execute(KnAPI.describeFeature(command, name, outputFormat));
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
