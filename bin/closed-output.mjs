// A reader that closes the pipe early (`opendoc review ... | head -c 100`) is not an error: drop what it no longer reads and let the command finish.
// Any other output error still throws.
for (const stream of [process.stdout, process.stderr]) stream.on('error', error => { if (error.code !== 'EPIPE') throw error; });
