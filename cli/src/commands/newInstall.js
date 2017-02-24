// @flow

import {
  signCodeStream,
} from "../lib/codeSign";

import {
  copyFile,
  mkdirp,
} from "../lib/fileUtils";

import {
  findFlowRoot,
} from "../lib/flowProjectUtils";

import {
  toSemverString as flowVersionToSemver,
  parseFlowSpecificVer,
} from "../lib/flowVersion";
import type {
  FlowVersion,
} from "../lib/flowVersion";

import {
  fs,
  path,
} from "../lib/node";

import {
  findNpmLibDef,
  getNpmLibDefVersionHash,
} from "../lib/npm/npmLibDefs";
import type {
  NpmLibDef,
} from "../lib/npm/npmLibDefs";

import {
  findFlowSpecificVer,
  getPackageJsonData,
  getPackageJsonDependencies,
} from "../lib/npm/npmProjectUtils";

import {
  getCacheRepoDir,
} from "../lib/cacheRepoUtils";

import {
  getRangeLowerBound,
} from "../lib/semver";

import
  colors
from "colors/safe";

import
  semver
from "semver";

import {
  createStub,
  pkgHasFlowFiles,
} from "../lib/stubUtils";

import
  typeof Yargs
from "yargs";

export const name = "new-install";
export const description = "Installs libdefs into the ./flow-typed directory";
export type Args = {
  _: Array<string>,
  flowVersion?: string,
  overwrite: bool,
  verbose: bool,
};
export function setup(yargs: Yargs) {
  return yargs
    .usage(`$0 ${name} - ${description}`)
    .options({
      flowVersion: {
        alias: 'f',
        describe: "The Flow version that fetched libdefs must be compatible " +
                  "with",
        type: "string",
      },
      overwrite: {
        alias: "o",
        describe: "If a libdef is already present locally, overwrite it with " +
                  "the latest fetched version",
        type: "boolean",
        demand: false,
      },
      verbose: {
        describe: "Print additional, verbose info while installing libdefs",
        type: "boolean",
        demand: false,
      },
    });
};
export async function run(args: Args) {
  const cwd = process.cwd();
  const flowVersion = await determineFlowVersion(cwd, args.flowVersion);
  const explicitLibDefs = args._.slice(1);

  const coreLibDefResult = await installCoreLibDefs();
  if (coreLibDefResult !== 0) {
    return coreLibDefResult;
  }

  const npmLibDefResult = await installNpmLibDefs({
    cwd,
    flowVersion,
    explicitLibDefs,
    verbose: args.verbose,
    overwrite: args.overwrite,
  });
  if (npmLibDefResult !== 0) {
    return npmLibDefResult;
  }
};

async function determineFlowVersion(cwd: string, flowVersionArg?: string) {
  if (flowVersionArg != null) {
    // Be permissive if the prefix 'v' is left off
    let flowVersionStr =
      flowVersionArg[0] === 'v'
      ? flowVersionArg
      : `v${flowVersionArg}`;

    if (/^v[0-9]+\.[0-9]+$/.test(flowVersionStr)) {
      flowVersionStr = `${flowVersionStr}.0`;
    }

    return {kind: 'specific', ver: parseFlowSpecificVer(flowVersionStr)};
  } else {
    return {kind: 'specific', ver: await findFlowSpecificVer(cwd)};
  }
}

async function installCoreLibDefs() {
  // TODO...
}

const FLOW_BUILT_IN_NPM_LIBS = [
  'react',
  'react-dom',
];
type installNpmLibDefsArgs = {
  cwd: string,
  flowVersion: FlowVersion,
  explicitLibDefs: Array<string>,
  verbose: boolean,
  overwrite: boolean,
};
async function installNpmLibDefs({
  cwd,
  flowVersion,
  explicitLibDefs,
  verbose,
  overwrite
}: installNpmLibDefsArgs): Promise<number> {
  const flowProjectRoot = await findFlowRoot(cwd);
  if (flowProjectRoot === null) {
    console.error(
      "Error: Unable to find a flow project in the current dir or any of " +
      "it's parent dirs!\n" +
      "Please run this command from within a Flow project."
    );
    return 1;
  }

  const libdefsToSearchFor: Map<string, string> = new Map();

  // If a specific pkg/version was specified, only add those packages.
  // Otherwise, extract dependencies from the package.json
  if (explicitLibDefs.length > 0) {
    for (var i = 0; i < explicitLibDefs.length; i++) {
      const term = explicitLibDefs[i];
      const termMatches = term.match(/(@[^@\/]+\/)?([^@]+)@(.+)/);
      if (termMatches == null) {
        console.error(
          "ERROR: Please specify npm package names in the format of `foo@1.2.3`"
        );
        return 1;
      }

      const [_, npmScope, pkgName, pkgVerStr] = termMatches;
      const scopedPkgName = npmScope == null ? npmScope + pkgName : pkgName;
      libdefsToSearchFor.set(scopedPkgName, pkgVerStr);
    }
    console.log(`• Searching for ${libdefsToSearchFor.size} libdefs...`);
  } else {
    const pkgJsonData = await getPackageJsonData(cwd);
    const pkgJsonDeps = getPackageJsonDependencies(pkgJsonData);
    for (const pkgName in pkgJsonDeps) {
      libdefsToSearchFor.set(pkgName, pkgJsonDeps[pkgName]);
    }

    if (libdefsToSearchFor.size === 0) {
      console.error(
        "No dependencies were found in this project's package.json!"
      );
      return 1;
    }

    if (verbose) {
      libdefsToSearchFor.forEach((ver, name) => {
        console.log(`• Found package.json dependency: ${name}@${ver}`);
      });
    } else {
      console.log(
        `• Found ${libdefsToSearchFor.size} dependencies in package.json to ` +
        `install libdefs for. Searching...`
      );
    }
  }
  const libDefsToSearchForEntries = [...libdefsToSearchFor.entries()];

  // Search for the requested libdefs
  const libDefsThatNeedUpdate = [];
  const libDefsToInstall = [];
  const missingLibDefs = [];
  await Promise.all(libDefsToSearchForEntries.map(async ([ver, name]) => {
    if (FLOW_BUILT_IN_NPM_LIBS.indexOf(name) !== -1) {
      return;
    }

    const libDef = await findNpmLibDef(name, ver, flowVersion);
    if (libDef === null) {
      missingLibDefs.push({name, ver});
    } else {
      libDefsToInstall.push(libDef);
      const libDefLower = getRangeLowerBound(libDef.version);
      const depLower = getRangeLowerBound(ver);
      if (semver.lt(libDefLower, depLower)) {
        libDefsThatNeedUpdate.push([libDef, {name, ver}]);
      }
    }
  }));

  if (libDefsToInstall.length > 0) {
    console.log(`• Installing ${libDefsToInstall.length} libDefs...`);
    const flowTypedDirPath = path.join(flowProjectRoot, 'flow-typed', 'npm');
    await mkdirp(flowTypedDirPath);
    const results = await Promise.all(libDefsToInstall.map(def => {
      return installNpmLibDef(def, flowTypedDirPath, overwrite);
    }));
    return results.some(res => !res) ? 1 : 0;
  }

  if ((verbose || missingLibDefs.length === 0)
      && libDefsThatNeedUpdate.length > 0) {
    console.log(
      "• The following installed libdefs are compatible with your " +
      "dependencies, but may not include all minor and patch changes for " +
      "your specific dependency version:\n"
    );
    libDefsThatNeedUpdate.forEach(([libDef, [pkgName, pkgVersion]]) => {
      console.log(
        "  • libdef: %s (satisfies %s)",
        colors.yellow(`${libDef.name}_${libDef.version}`),
        colors.bold(`${pkgName}@${pkgVersion}`),
      );

      const libDefPlural =
        libDefsThatNeedUpdate.length > 1
        ? ["versioned updates", "these packages"]
        : ["a versioned update", "this package"];
      console.log(
        `\n` +
        `  Consider submitting ${libDefPlural[0]} for ${libDefPlural[1]} to \n` +
        `  https://github.com/flowtype/flow-typed/\n`
      );
    });
  }

  if (missingLibDefs.length > 0
      && missingLibDefs.length === explicitLibDefs.length) {
    // If the user specified an explicit library to be installed, don't generate
    // a stub if no libdef exists -- just inform them that one doesn't exist
    console.log(
      colors.red(
        `!! No libdefs found in flow-typed for the explicitly requested libdefs. !!`
      ) +
      "\n" +
      "\n" +
      "Consider using `%s` to generate an empty libdef that you can fill in.",
      colors.bold(`flow-typed create-stub ${explicitLibDefs.join(' ')}`)
    );
  } else {
    // If a package that's missing a flow-typed libdef has any .flow files,
    // we'll skip generating a stub for it.
    const untypedMissingLibDefs = [];
    const typedMissingLibDefs = [];
    await Promise.all(missingLibDefs.map(async ([pkgName, pkgVerStr]) => {
      const hasFlowFiles = await pkgHasFlowFiles(cwd, pkgName);
      if (hasFlowFiles) {
        typedMissingLibDefs.push([pkgName, pkgVerStr]);
      } else {
        untypedMissingLibDefs.push([pkgName, pkgVerStr]);
      }
    }));

    if (untypedMissingLibDefs.length > 0) {
      console.log('• Generating stubs for untyped dependencies...');
      await Promise.all(
        untypedMissingLibDefs.map(async ([pkgName, pkgVerStr]) => {
          await createStub(
            flowProjectRoot,
            pkgName,
            pkgVerStr,
            overwrite,
          );
        })
      );

      console.log(colors.red(
        `\n!! No flow@${flowVersionToSemver(flowVersion)}-compatible libdefs ` +
        `found in flow-typed for the above untyped dependencies !!`
      ));

      const plural =
        missingLibDefs.length > 1
        ? ['libdefs', 'these packages', 'them']
        : ['a libdef', 'this package', 'it'];
      console.log(
        `\n` +
        `I've generated ${'`'}any${'`'}-typed stubs for ${plural[1]}, but ` +
        `consider submitting ${plural[0]} for ${plural[2]} to ` +
        `${colors.bold('https://github.com/flowtype/flow-typed/')}\n`
      );
    }
  }

  return 1;
}

async function installNpmLibDef(
  npmLibDef: NpmLibDef,
  npmDir: string,
  overwrite: boolean
): Promise<boolean> {
  const scopedDir =
    npmLibDef.scope === null
    ? npmDir
    : path.join(npmDir, '@' + npmLibDef.scope);
  mkdirp(scopedDir);

  const fileName = `${npmLibDef.name}_${npmLibDef.version}.js`;
  const filePath = path.join(scopedDir, fileName);

  // Find the libDef in the cached repo
  try {
    const terseFilePath = path.relative(
      path.resolve(npmDir, '..', '..'),
      filePath
    );
    if ((await fs.exists(filePath)) && !overwrite) {
      console.error(
        "  • %s\n" +
        "    └> %s",

        colors.bold(colors.red(`${terseFilePath} already exists!`)),
        "Use --overwrite to overwrite the existing libdef.",
      );
      return false;
    }

    const repoVersion = await getNpmLibDefVersionHash(
      getCacheRepoDir(),
      npmLibDef,
    );
    const codeSignPreprocessor = signCodeStream(repoVersion);
    await copyFile(npmLibDef.path, filePath, codeSignPreprocessor);

    console.log(
      colors.bold(
        "  • %s\n" +
        "    └> %s"
      ),
      fileName,
      colors.green(`.${path.sep}${terseFilePath}`)
    );

    return true;
  } catch (e) {
    console.error(`  !! Failed to install ${npmLibDef.name} at ${filePath}`);
    console.error(`  ERROR: ${e.message}`);
    return false;
  }
}

export {
  determineFlowVersion as _determineFlowVersion,
  installNpmLibDefs as _installNpmLibDefs,
  installNpmLibDef as _installNpmLibDef,
};
