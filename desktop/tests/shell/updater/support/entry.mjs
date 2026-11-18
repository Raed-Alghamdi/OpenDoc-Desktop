// The app's entry point for the updater's tests: the native stub first (dialogs, the system browser and relaunch answered and
// recorded from the first moment), then the real main process. Playwright removes NODE_OPTIONS, so the stub cannot be preloaded.
import './native-stub.cjs';
import '../../../../src/main/index.mjs';
