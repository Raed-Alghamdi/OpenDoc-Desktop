// The environment runtime/dist.mjs gives electron-builder.
//
// No keychain search for a signing identity: the config names its own ("-", ad-hoc). On a Mac, signing also happens for a pull
// request build, which electron-builder would otherwise skip: ad-hoc signing needs no secret, and a pull request then builds the app
// exactly as a release does, signing hooks included (runtime/mac-signing.mjs).
export function builderEnvironment(environment, platform) {
  const result = { ...environment, CSC_IDENTITY_AUTO_DISCOVERY: environment.CSC_IDENTITY_AUTO_DISCOVERY ?? 'false' };
  if (platform === 'darwin') result.CSC_FOR_PULL_REQUEST = 'true';
  return result;
}
