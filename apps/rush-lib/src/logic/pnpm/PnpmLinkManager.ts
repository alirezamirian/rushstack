// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as os from 'os';
import * as path from 'path';
import uriEncode = require('strict-uri-encode');
import pnpmLinkBins from '@pnpm/link-bins';
import * as semver from 'semver';
import * as colors from 'colors';

import { JsonFile, Text, FileSystem, FileConstants, InternalError } from '@rushstack/node-core-library';

import { BaseLinkManager } from '../base/BaseLinkManager';
import { BasePackage } from '../base/BasePackage';
import { RushConstants } from '../../logic/RushConstants';
import { IRushLinkJson } from '../../api/RushConfiguration';
import { RushConfigurationProject } from '../../api/RushConfigurationProject';
import {
  PnpmShrinkwrapFile,
  IPnpmShrinkwrapDependencyYaml,
  IPnpmShrinkwrapImporterYaml
} from './PnpmShrinkwrapFile';
import { PnpmProjectDependencyManifest } from './PnpmProjectDependencyManifest';
import { PackageJsonDependency, DependencyType } from '../../api/PackageJsonEditor';
import { DependencySpecifier, SpecifierType } from '../DependencySpecifier';

// special flag for debugging, will print extra diagnostic information,
// but comes with performance cost
const DEBUG: boolean = false;

export class PnpmLinkManager extends BaseLinkManager {
  private readonly _pnpmVersion: semver.SemVer = new semver.SemVer(
    this._rushConfiguration.packageManagerToolVersion
  );

  protected async _linkProjects(): Promise<void> {
    const rushLinkJson: IRushLinkJson = {
      localLinks: {}
    };

    if (this._rushConfiguration.projects.length > 0) {
      // Use shrinkwrap from temp as the committed shrinkwrap may not always be up to date
      // See https://github.com/microsoft/rushstack/issues/1273#issuecomment-492779995
      const pnpmShrinkwrapFile: PnpmShrinkwrapFile | undefined = PnpmShrinkwrapFile.loadFromFile(
        this._rushConfiguration.tempShrinkwrapFilename,
        this._rushConfiguration.pnpmOptions
      );

      if (!pnpmShrinkwrapFile) {
        throw new InternalError(
          `Cannot load shrinkwrap at "${this._rushConfiguration.tempShrinkwrapFilename}"`
        );
      }

      const useWorkspaces: boolean =
        this._rushConfiguration.packageManager === 'pnpm' &&
        this._rushConfiguration.pnpmOptions &&
        this._rushConfiguration.pnpmOptions.useWorkspaces;

      for (const rushProject of this._rushConfiguration.projects) {
        if (useWorkspaces) {
          await this._linkWorkspaceProject(rushProject, rushLinkJson, pnpmShrinkwrapFile);
        } else {
          await this._linkProject(rushProject, rushLinkJson, pnpmShrinkwrapFile);
        }
      }
    } else {
      console.log(
        colors.yellow(
          '\nWarning: Nothing to do. Please edit rush.json and add at least one project' +
            ' to the "projects" section.\n'
        )
      );
    }

    console.log(`Writing "${this._rushConfiguration.rushLinkJsonFilename}"`);
    JsonFile.save(rushLinkJson, this._rushConfiguration.rushLinkJsonFilename);
  }

  /**
   * This is called once for each local project from Rush.json.
   * @param project             The local project that we will create symlinks for
   * @param rushLinkJson        The common/temp/rush-link.json output file
   */
  private async _linkProject(
    project: RushConfigurationProject,
    rushLinkJson: IRushLinkJson,
    pnpmShrinkwrapFile: PnpmShrinkwrapFile
  ): Promise<void> {
    console.log(os.EOL + 'LINKING: ' + project.packageName);

    // first, read the temp package.json information
    // Example: "project1"
    const unscopedTempProjectName: string = this._rushConfiguration.packageNameParser.getUnscopedName(
      project.tempProjectName
    );

    // Example: "C:\MyRepo\common\temp\projects\project1
    const extractedFolder: string = path.join(
      this._rushConfiguration.commonTempFolder,
      RushConstants.rushTempProjectsFolderName,
      unscopedTempProjectName
    );

    // Example: "C:\MyRepo\common\temp\projects\project1\package.json"
    const packageJsonFilename: string = path.join(extractedFolder, FileConstants.PackageJson);

    // Example: "C:\MyRepo\common\temp\node_modules\@rush-temp\project1"
    const installFolderName: string = path.join(
      this._rushConfiguration.commonTempFolder,
      RushConstants.nodeModulesFolderName,
      RushConstants.rushTempNpmScope,
      unscopedTempProjectName
    );

    const commonPackage: BasePackage = BasePackage.createVirtualTempPackage(
      packageJsonFilename,
      installFolderName
    );

    const localPackage: BasePackage = BasePackage.createLinkedPackage(
      project.packageJsonEditor.name,
      commonPackage.version,
      project.projectFolder
    );

    // now that we have the temp package.json, we can go ahead and link up all the direct dependencies

    // first, start with the rush dependencies, we just need to link to the project folder
    for (const dependencyName of Object.keys(commonPackage.packageJson!.rushDependencies || {})) {
      const matchedRushPackage:
        | RushConfigurationProject
        | undefined = this._rushConfiguration.getProjectByName(dependencyName);

      if (matchedRushPackage) {
        // We found a suitable match, so place a new local package that
        // symlinks to the Rush project
        const matchedVersion: string = matchedRushPackage.packageJsonEditor.version;

        let localLinks: string[] = rushLinkJson.localLinks[localPackage.name];
        if (!localLinks) {
          localLinks = [];
          rushLinkJson.localLinks[localPackage.name] = localLinks;
        }
        localLinks.push(dependencyName);

        // e.g. "C:\my-repo\project-a\node_modules\project-b" if project-b is a rush dependency of project-a
        const newLocalFolderPath: string = path.join(localPackage.folderPath, 'node_modules', dependencyName);

        const newLocalPackage: BasePackage = BasePackage.createLinkedPackage(
          dependencyName,
          matchedVersion,
          newLocalFolderPath
        );

        newLocalPackage.symlinkTargetFolderPath = matchedRushPackage.projectFolder;
        localPackage.children.push(newLocalPackage);
      } else {
        throw new InternalError(
          `Cannot find dependency "${dependencyName}" for "${project.packageName}" in the Rush configuration`
        );
      }
    }

    // Iterate through all the regular dependencies

    // With npm, it's possible for two different projects to have dependencies on
    // the same version of the same library, but end up with different implementations
    // of that library, if the library is installed twice and with different secondary
    // dependencies.The NpmLinkManager recursively links dependency folders to try to
    // honor this. Since PNPM always uses the same physical folder to represent a given
    // version of a library, we only need to link directly to the folder that PNPM has chosen,
    // and it will have a consistent set of secondary dependencies.

    // each of these dependencies should be linked in a special folder that pnpm
    // creates for the installed version of each .TGZ package, all we need to do
    // is re-use that symlink in order to get linked to whatever PNPM thought was
    // appropriate. This folder is usually something like:
    // C:\{uri-encoded-path-to-tgz}\node_modules\{package-name}

    // e.g.:
    //   file:projects/bentleyjs-core.tgz
    //   file:projects/build-tools.tgz_dc21d88642e18a947127a751e00b020a
    //   file:projects/imodel-from-geojson.tgz_request@2.88.0
    const tempProjectDependencyKey: string | undefined = pnpmShrinkwrapFile.getTempProjectDependencyKey(
      project.tempProjectName
    );

    if (!tempProjectDependencyKey) {
      throw new Error(`Cannot get dependency key for temp project: ${project.tempProjectName}`);
    }
    // e.g.: file:projects/project-name.tgz
    const tarballEntry: string | undefined = pnpmShrinkwrapFile.getTarballPath(tempProjectDependencyKey);

    if (!tarballEntry) {
      throw new InternalError(`Cannot find tarball path for "${project.tempProjectName}" in shrinkwrap.`);
    }

    // e.g.: projects\api-documenter.tgz
    const relativePathToTgzFile: string | undefined = tarballEntry.slice(`file:`.length);

    // e.g.: C:\wbt\common\temp\projects\api-documenter.tgz
    const absolutePathToTgzFile: string = path.resolve(
      this._rushConfiguration.commonTempFolder,
      relativePathToTgzFile
    );

    // The folder name in `.local` is constructed as:
    //   UriEncode(absolutePathToTgzFile) + _suffix
    //
    // Note that _suffix is not encoded. The tarball attribute of the package 'file:projects/project-name.tgz_suffix'
    // holds the tarball path 'file:projects/project-name.tgz', which can be used for the constructing the folder name.
    //
    // '_suffix' is extracted by stripping the tarball path from top level dependency value.
    // tarball path = 'file:projects/project-name.tgz'
    // top level dependency = 'file:projects/project-name.tgz_suffix'

    // e.g.:
    //   '' [empty string]
    //   _jsdom@11.12.0
    //   _2a665c89609864b4e75bc5365d7f8f56
    const folderNameSuffix: string =
      tarballEntry && tarballEntry.length < tempProjectDependencyKey.length
        ? tempProjectDependencyKey.slice(tarballEntry.length)
        : '';

    // e.g.:
    //   C%3A%2Fwbt%2Fcommon%2Ftemp%2Fprojects%2Fapi-documenter.tgz
    //   C%3A%2Fdev%2Fimodeljs%2Fimodeljs%2Fcommon%2Ftemp%2Fprojects%2Fpresentation-integration-tests.tgz_jsdom@11.12.0
    //   C%3A%2Fdev%2Fimodeljs%2Fimodeljs%2Fcommon%2Ftemp%2Fprojects%2Fbuild-tools.tgz_2a665c89609864b4e75bc5365d7f8f56
    const folderNameInLocalInstallationRoot: string =
      uriEncode(Text.replaceAll(absolutePathToTgzFile, path.sep, '/')) + folderNameSuffix;

    // e.g.: C:\wbt\common\temp\node_modules\.local\C%3A%2Fwbt%2Fcommon%2Ftemp%2Fprojects%2Fapi-documenter.tgz\node_modules

    const pathToLocalInstallation: string = this._getPathToLocalInstallation(
      folderNameInLocalInstallationRoot
    );

    const parentShrinkwrapEntry:
      | IPnpmShrinkwrapDependencyYaml
      | undefined = pnpmShrinkwrapFile.getShrinkwrapEntryFromTempProjectDependencyKey(
      tempProjectDependencyKey
    );
    if (!parentShrinkwrapEntry) {
      throw new InternalError(
        `Cannot find shrinkwrap entry using dependency key for temp project: ${project.tempProjectName}`
      );
    }

    const pnpmProjectDependencyManifest: PnpmProjectDependencyManifest = new PnpmProjectDependencyManifest({
      pnpmShrinkwrapFile,
      project
    });

    for (const dependencyName of Object.keys(commonPackage.packageJson!.dependencies || {})) {
      const newLocalPackage: BasePackage = this._createLocalPackageForDependency(
        pnpmProjectDependencyManifest,
        project,
        parentShrinkwrapEntry,
        localPackage,
        pathToLocalInstallation,
        dependencyName
      )!;
      localPackage.addChild(newLocalPackage);
    }

    // TODO: Rush does not currently handle optional dependencies of projects. This should be uncommented when
    // support is added
    // for (const dependencyName of Object.keys(commonPackage.packageJson!.optionalDependencies || {})) {
    //   const newLocalPackage: BasePackage | undefined = this._createLocalPackageForDependency(
    //     pnpmProjectDependencyManifest,
    //     project,
    //     parentShrinkwrapEntry,
    //     localPackage,
    //     pathToLocalInstallation,
    //     dependencyName,
    //     true); // isOptional
    //   if (newLocalPackage) {
    //     localPackage.addChild(newLocalPackage);
    //   }
    // }

    if (DEBUG) {
      localPackage.printTree();
    }

    PnpmLinkManager._createSymlinksForTopLevelProject(localPackage);

    if (
      !this._rushConfiguration.experimentsConfiguration.configuration
        .legacyIncrementalBuildDependencyDetection
    ) {
      pnpmProjectDependencyManifest.save();
    } else {
      pnpmProjectDependencyManifest.deleteIfExists();
    }

    // Also symlink the ".bin" folder
    const projectFolder: string = path.join(localPackage.folderPath, 'node_modules');
    const projectBinFolder: string = path.join(localPackage.folderPath, 'node_modules', '.bin');

    await pnpmLinkBins(projectFolder, projectBinFolder, {
      warn: (msg: string) => console.warn(colors.yellow(msg))
    });
  }

  /**
   * This is called once for each local project from Rush.json.
   *
   * TODO: This should be moved into WorkspaceInstallManager directly, since there is no actual linking
   * being done by Rush for this style of install.
   *
   * @param project             The local project that we will create symlinks for
   * @param rushLinkJson        The common/temp/rush-link.json output file
   */
  private async _linkWorkspaceProject(
    project: RushConfigurationProject,
    rushLinkJson: IRushLinkJson,
    pnpmShrinkwrapFile: PnpmShrinkwrapFile
  ): Promise<void> {
    // First, generate the local dependency graph. When using workspaces, Rush forces `workspace:`
    // notation for all locally-referenced projects.
    const localDependencies: PackageJsonDependency[] = [
      ...project.packageJsonEditor.dependencyList,
      ...project.packageJsonEditor.devDependencyList
    ].filter((x) => new DependencySpecifier(x.name, x.version).specifierType === SpecifierType.Workspace);

    for (const { name } of localDependencies) {
      const matchedRushPackage:
        | RushConfigurationProject
        | undefined = this._rushConfiguration.getProjectByName(name);

      if (matchedRushPackage) {
        // We found a suitable match, so add the local package as a local link
        let localLinks: string[] = rushLinkJson.localLinks[project.packageName];
        if (!localLinks) {
          localLinks = [];
          rushLinkJson.localLinks[project.packageName] = localLinks;
        }
        localLinks.push(name);
      } else {
        throw new InternalError(
          `Cannot find dependency "${name}" for "${project.packageName}" in the Rush configuration`
        );
      }
    }

    const importerKey: string = pnpmShrinkwrapFile.getWorkspaceKeyByPath(
      this._rushConfiguration.commonTempFolder,
      project.projectFolder
    );
    const workspaceImporter:
      | IPnpmShrinkwrapImporterYaml
      | undefined = pnpmShrinkwrapFile.getWorkspaceImporter(importerKey);
    if (!workspaceImporter) {
      throw new InternalError(
        `Cannot find shrinkwrap entry using importer key for workspace project: ${importerKey}`
      );
    }
    const pnpmProjectDependencyManifest: PnpmProjectDependencyManifest = new PnpmProjectDependencyManifest({
      pnpmShrinkwrapFile,
      project
    });
    const useProjectDependencyManifest: boolean = !this._rushConfiguration.experimentsConfiguration
      .configuration.legacyIncrementalBuildDependencyDetection;

    // Then, do non-local dependencies
    const dependencies: PackageJsonDependency[] = [
      ...project.packageJsonEditor.dependencyList,
      ...project.packageJsonEditor.devDependencyList
    ].filter((x) => new DependencySpecifier(x.name, x.version).specifierType !== SpecifierType.Workspace);

    for (const { name, dependencyType } of dependencies) {
      // read the version number from the shrinkwrap entry
      let version: string | undefined;
      switch (dependencyType) {
        case DependencyType.Regular:
          version = (workspaceImporter.dependencies || {})[name];
          break;
        case DependencyType.Dev:
          // Dev dependencies are folded into dependencies if there is a duplicate
          // definition, so we should also check there
          version =
            (workspaceImporter.devDependencies || {})[name] || (workspaceImporter.dependencies || {})[name];
          break;
        case DependencyType.Optional:
          version = (workspaceImporter.optionalDependencies || {})[name];
          break;
        case DependencyType.Peer:
          // Peer dependencies do not need to be considered since they aren't a true
          // dependency, and would be satisfied in the consuming package. They are
          // also not specified in the workspace importer
          continue;
      }

      if (!version) {
        // Optional dependencies by definition may not exist, so avoid throwing on these
        if (dependencyType !== DependencyType.Optional) {
          throw new InternalError(
            `Cannot find shrinkwrap entry dependency "${name}" for workspace project: ${project.packageName}`
          );
        }
        continue;
      }

      if (useProjectDependencyManifest) {
        // Add to the manifest and provide all the parent dependencies. Peer dependencies are not mapped at
        // the importer level, so provide an empty object for that
        pnpmProjectDependencyManifest.addDependency(name, version, {
          dependencies: { ...workspaceImporter.dependencies, ...workspaceImporter.devDependencies },
          optionalDependencies: { ...workspaceImporter.optionalDependencies },
          peerDependencies: {}
        });
      }
    }

    if (useProjectDependencyManifest) {
      pnpmProjectDependencyManifest.save();
    } else {
      pnpmProjectDependencyManifest.deleteIfExists();
    }
  }

  private _getPathToLocalInstallation(folderNameInLocalInstallationRoot: string): string {
    // See https://github.com/pnpm/pnpm/releases/tag/v4.0.0
    if (this._pnpmVersion.major >= 4) {
      return path.join(
        this._rushConfiguration.commonTempFolder,
        RushConstants.nodeModulesFolderName,
        '.pnpm',
        'local',
        folderNameInLocalInstallationRoot,
        RushConstants.nodeModulesFolderName
      );
    } else {
      return path.join(
        this._rushConfiguration.commonTempFolder,
        RushConstants.nodeModulesFolderName,
        '.local',
        folderNameInLocalInstallationRoot,
        RushConstants.nodeModulesFolderName
      );
    }
  }
  private _createLocalPackageForDependency(
    pnpmProjectDependencyManifest: PnpmProjectDependencyManifest,
    project: RushConfigurationProject,
    parentShrinkwrapEntry: IPnpmShrinkwrapDependencyYaml,
    localPackage: BasePackage,
    pathToLocalInstallation: string,
    dependencyName: string,
    isOptional: boolean = false
  ): BasePackage | undefined {
    // the dependency we are looking for should have already created a symlink here

    // FYI dependencyName might contain an NPM scope, here it gets converted into a filesystem folder name
    // e.g. if the dependency is supi:
    // "C:\wbt\common\temp\node_modules\.local\C%3A%2Fwbt%2Fcommon%2Ftemp%2Fprojects%2Fapi-documenter.tgz\node_modules\supi"
    const dependencyLocalInstallationSymlink: string = path.join(pathToLocalInstallation, dependencyName);

    if (!FileSystem.exists(dependencyLocalInstallationSymlink)) {
      // if this occurs, it is a bug in Rush algorithm or unexpected PNPM behavior
      throw new InternalError(
        `Cannot find installed dependency "${dependencyName}" in "${pathToLocalInstallation}"`
      );
    }

    if (!FileSystem.getLinkStatistics(dependencyLocalInstallationSymlink).isSymbolicLink()) {
      // if this occurs, it is a bug in Rush algorithm or unexpected PNPM behavior
      throw new InternalError(
        `Dependency "${dependencyName}" is not a symlink in "${pathToLocalInstallation}`
      );
    }

    // read the version number from the shrinkwrap entry and return if no version is specified
    // and the dependency is optional
    const version: string | undefined = isOptional
      ? (parentShrinkwrapEntry.optionalDependencies || {})[dependencyName]
      : (parentShrinkwrapEntry.dependencies || {})[dependencyName];
    if (!version) {
      if (!isOptional) {
        throw new InternalError(
          `Cannot find shrinkwrap entry dependency "${dependencyName}" for temp project: ` +
            `${project.tempProjectName}`
        );
      }
      return;
    }

    const newLocalFolderPath: string = path.join(localPackage.folderPath, 'node_modules', dependencyName);
    const newLocalPackage: BasePackage = BasePackage.createLinkedPackage(
      dependencyName,
      version,
      newLocalFolderPath
    );

    // The dependencyLocalInstallationSymlink is just a symlink to another folder. To reduce the number of filesystem
    // reads that are needed, we will link to where that symlink pointed, rather than linking to a link.
    newLocalPackage.symlinkTargetFolderPath = FileSystem.getRealPath(dependencyLocalInstallationSymlink);

    if (
      !this._rushConfiguration.experimentsConfiguration.configuration
        .legacyIncrementalBuildDependencyDetection
    ) {
      pnpmProjectDependencyManifest.addDependency(
        newLocalPackage.name,
        newLocalPackage.version!,
        parentShrinkwrapEntry
      );
    }

    return newLocalPackage;
  }
}
