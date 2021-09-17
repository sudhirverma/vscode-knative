/*-----------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE file in the project root for license information.
 *-----------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as yaml from 'js-yaml';
import { FolderPick, FuncContent, ImageAndBuild } from './function-type';
import { knExecutor } from '../cli/execute';
import { FuncAPI } from '../cli/func-api';
import { ExistingWorkspaceFolderPick } from '../util/existing-workspace-folder-pick';

const imageRegex = RegExp('[^/]+\\.[^/.]+\\/([^/.]+)(?:\\/[\\w\\s._-]*([\\w\\s._-]))*(?::[a-z0-9\\.-]+)?$');

async function functionBuilder(image: string): Promise<ImageAndBuild> {
  const builder = await vscode.window.showInputBox({
    ignoreFocusOut: true,
    prompt: 'Provide Buildpack builder, either an as a an image name or a mapping name.',
    validateInput: (value: string) => {
      if (!imageRegex.test(value)) {
        return 'Provide full image name in the form [registry]/[namespace]/[name]:[tag]';
      }
      return null;
    },
  });
  if (!builder) {
    return null;
  }
  return { image, builder };
}

async function functionImage(selectedFolderPick: vscode.Uri, skipBuilder?: boolean): Promise<ImageAndBuild> {
  const imageList: string[] = [];
  let funcData: FuncContent[];
  try {
    const funcYaml: string = await fs.readFile(path.join(selectedFolderPick.fsPath, 'func.yaml'), 'utf-8');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    funcData = yaml.safeLoadAll(funcYaml);
    if (funcData?.[0]?.image && imageRegex.test(funcData?.[0].image)) {
      imageList.push(funcData[0].image);
    }
  } catch (error) {
    // ignore
  }
  const imagePick =
    imageList.length === 1
      ? imageList[0]
      : await vscode.window.showInputBox({
          ignoreFocusOut: true,
          prompt: 'Provide full image name in the form [registry]/[namespace]/[name]:[tag]',
          validateInput: (value: string) => {
            if (!imageRegex.test(value)) {
              return 'Provide full image name in the form [registry]/[namespace]/[name]:[tag]';
            }
            return null;
          },
        });
  if (!imagePick) {
    return null;
  }
  if (!funcData?.[0]?.builder.trim() && !skipBuilder) {
    const builder = await functionBuilder(imagePick);
    if (!builder) {
      return null;
    }
    return builder;
  }
  return { image: imagePick };
}

async function pathFunction(): Promise<FolderPick> {
  const folderPicks: FolderPick[] = [];
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    // eslint-disable-next-line no-restricted-syntax
    for (const wf of vscode.workspace.workspaceFolders) {
      if (fs.existsSync(path.join(wf.uri.fsPath, 'func.yaml'))) {
        folderPicks.push(new ExistingWorkspaceFolderPick(wf));
      }
    }
  }
  if (folderPicks.length === 0) {
    const message = 'No project exit which contain func.yaml in it.';
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    vscode.window.showInformationMessage(message);
    return null;
  }
  const selectedFolderPick =
    folderPicks.length === 1
      ? folderPicks[0]
      : await vscode.window.showQuickPick(folderPicks, {
          canPickMany: false,
          ignoreFocusOut: true,
          placeHolder: 'Select function',
        });
  if (!selectedFolderPick) {
    return null;
  }
  return selectedFolderPick;
}

export async function buildFunction(): Promise<void> {
  const selectedFolderPick = await pathFunction();
  if (!selectedFolderPick) {
    return null;
  }
  if (!selectedFolderPick && selectedFolderPick.workspaceFolder.uri) {
    return null;
  }
  const funcData = await functionImage(selectedFolderPick.workspaceFolder.uri);
  if (!funcData) {
    return null;
  }
  await knExecutor.executeInTerminal(
    FuncAPI.buildFunc(selectedFolderPick.workspaceFolder.uri.fsPath, funcData.image, funcData.builder),
  );
}

export async function deployFunction(): Promise<void> {
  const selectedFolderPick = await pathFunction();
  if (!selectedFolderPick) {
    return null;
  }
  if (!selectedFolderPick && selectedFolderPick.workspaceFolder.uri) {
    return null;
  }
  const funcData = await functionImage(selectedFolderPick.workspaceFolder.uri, true);
  if (!funcData) {
    return null;
  }
  await knExecutor.executeInTerminal(FuncAPI.deployFunc(selectedFolderPick.workspaceFolder.uri.fsPath, funcData.image));
}
