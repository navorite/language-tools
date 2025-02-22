import path, { dirname, isAbsolute, join } from 'path';
import { existsSync, readdirSync, statSync, writeFileSync } from 'fs';
import ts from 'typescript';
import { DocumentManager, Document } from '../../../src/lib/documents';
import { FileMap } from '../../../src/lib/documents/fileCollection';
import { LSConfigManager } from '../../../src/ls-config';
import { LSAndTSDocResolver } from '../../../src/plugins';
import { createGetCanonicalFileName, normalizePath, pathToUrl } from '../../../src/utils';

export function createVirtualTsSystem(currentDirectory: string): ts.System {
    const virtualFs = new FileMap<string>();
    // array behave more similar to the actual fs event than Set
    const watchers = new FileMap<ts.FileWatcherCallback[]>();
    const watchTimeout = new FileMap<Array<ReturnType<typeof setTimeout>>>();
    const getCanonicalFileName = createGetCanonicalFileName(ts.sys.useCaseSensitiveFileNames);
    const modifiedTime = new FileMap<Date>();

    function toAbsolute(path: string) {
        return isAbsolute(path) ? path : join(currentDirectory, path);
    }

    const virtualSystem: ts.System = {
        ...ts.sys,
        getCurrentDirectory() {
            return currentDirectory;
        },
        writeFile(path, data) {
            const normalizedPath = normalizePath(toAbsolute(path));
            const existsBefore = virtualFs.has(normalizedPath);
            virtualFs.set(normalizedPath, data);
            modifiedTime.set(normalizedPath, new Date());
            triggerWatch(
                normalizedPath,
                existsBefore ? ts.FileWatcherEventKind.Changed : ts.FileWatcherEventKind.Created
            );
        },
        readFile(path) {
            return virtualFs.get(normalizePath(toAbsolute(path)));
        },
        fileExists(path) {
            return virtualFs.has(normalizePath(toAbsolute(path)));
        },
        directoryExists(path) {
            const normalizedPath = getCanonicalFileName(normalizePath(toAbsolute(path)));
            return Array.from(virtualFs.keys()).some((fileName) =>
                fileName.startsWith(normalizedPath)
            );
        },
        deleteFile(path) {
            const normalizedPath = normalizePath(toAbsolute(path));
            const existsBefore = virtualFs.has(normalizedPath);
            virtualFs.delete(normalizedPath);

            if (existsBefore) {
                triggerWatch(normalizedPath, ts.FileWatcherEventKind.Deleted);
            }
        },
        watchFile(path, callback) {
            const normalizedPath = normalizePath(toAbsolute(path));
            let watchersOfPath = watchers.get(normalizedPath);

            if (!watchersOfPath) {
                watchersOfPath = [];
                watchers.set(normalizedPath, watchersOfPath);
            }

            watchersOfPath.push(callback);

            return {
                close() {
                    const watchersOfPath = watchers.get(normalizedPath);

                    if (watchersOfPath) {
                        watchers.set(
                            normalizedPath,
                            watchersOfPath.filter((watcher) => watcher === callback)
                        );
                    }

                    const timeouts = watchTimeout.get(normalizedPath);

                    if (timeouts != null) {
                        timeouts.forEach((timeout) => clearTimeout(timeout));
                    }
                }
            };
        },
        getModifiedTime(path) {
            return modifiedTime.get(normalizePath(toAbsolute(path)));
        }
    };

    return virtualSystem;

    function triggerWatch(normalizedPath: string, kind: ts.FileWatcherEventKind) {
        let timeoutsOfPath = watchTimeout.get(normalizedPath);

        if (!timeoutsOfPath) {
            timeoutsOfPath = [];
            watchTimeout.set(normalizedPath, timeoutsOfPath);
        }

        timeoutsOfPath.push(
            setTimeout(
                () =>
                    watchers
                        .get(normalizedPath)
                        ?.forEach((callback) => callback(normalizedPath, kind)),
                0
            )
        );
    }
}

export function getRandomVirtualDirPath(testDir: string) {
    return path.join(testDir, `virtual-path-${Math.floor(Math.random() * 100_000)}`);
}

interface VirtualEnvironmentOptions {
    testDir: string;
    filename: string;
    fileContent: string;
}

export function setupVirtualEnvironment({
    testDir,
    fileContent,
    filename
}: VirtualEnvironmentOptions) {
    const docManager = new DocumentManager(
        (textDocument) => new Document(textDocument.uri, textDocument.text)
    );

    const lsConfigManager = new LSConfigManager();

    const virtualSystem = createVirtualTsSystem(testDir);
    const lsAndTsDocResolver = new LSAndTSDocResolver(
        docManager,
        [pathToUrl(testDir)],
        lsConfigManager,
        {
            tsSystem: virtualSystem
        }
    );

    const filePath = join(testDir, filename);
    virtualSystem.writeFile(filePath, fileContent);
    const document = docManager.openDocument(<any>{
        uri: pathToUrl(filePath),
        text: virtualSystem.readFile(filePath) || ''
    });

    return {
        lsAndTsDocResolver,
        document,
        docManager,
        virtualSystem,
        lsConfigManager
    };
}

export function createSnapshotTester<TestOptions extends { dir: string; workspaceDir: string }>(
    executeTest: (inputFile: string, testOptions: TestOptions) => Promise<void>
) {
    return function executeTests(testOptions: TestOptions) {
        const { dir } = testOptions;
        const inputFile = join(dir, 'input.svelte');
        if (existsSync(inputFile)) {
            const _it = dir.endsWith('.only') ? it.only : it;
            _it(dir.substring(__dirname.length), () => executeTest(inputFile, testOptions)).timeout(
                5000
            );
        } else {
            const _describe = dir.endsWith('.only') ? describe.only : describe;
            _describe(dir.substring(__dirname.length), () => {
                const subDirs = readdirSync(dir);

                for (const subDir of subDirs) {
                    if (statSync(join(dir, subDir)).isDirectory()) {
                        executeTests({
                            ...testOptions,
                            dir: join(dir, subDir)
                        });
                    }
                }
            });
        }
    };
}

export function updateSnapshotIfFailedOrEmpty({
    assertion,
    expectedFile,
    rootDir,
    getFileContent
}: {
    assertion: () => void;
    expectedFile: string;
    rootDir: string;
    getFileContent: () => string;
}) {
    if (existsSync(expectedFile)) {
        try {
            assertion();
        } catch (e) {
            if (process.argv.includes('--auto')) {
                writeFile(`Updated ${expectedFile} for`);
            } else {
                throw e;
            }
        }
    } else {
        writeFile(`Created ${expectedFile} for`);
    }

    function writeFile(msg: string) {
        console.info(msg, dirname(expectedFile).substring(rootDir.length));
        writeFileSync(expectedFile, getFileContent(), 'utf-8');
    }
}
