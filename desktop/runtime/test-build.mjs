// The test build mark. A packaged app whose package.json (inside app.asar) has this field honours the test switches and a plain-http
// loopback update address (src/main/build-mode.mjs); a release must never carry it. `dist.mjs` writes it when the variable below is
// 1, and tests/packaging/check-release.mjs and check-packaged.mjs --release fail when a built artifact has it.
export const testBuildField = 'opendocTestBuild';
export const testBuildVariable = 'OPENDOC_DESKTOP_TEST_BUILD';

/** The electron-builder argument that makes a test build, or nothing. Only the value 1 asks for it. */
export const testBuildArguments = (env = process.env) => (env[testBuildVariable] === '1' ? [`-c.extraMetadata.${testBuildField}=true`] : []);
