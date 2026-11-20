/**
 * Vitest loads this before every test file. The dashboard seeds and writes its
 * project registry under the XDG config home; point that at a scratch
 * directory so no suite — nor any server it spawns with `process.env` — ever
 * touches the operator's real `~/.config/ralph/projects.json`.
 *
 * The directory is removed when the file that got it is done. It used not to
 * be, and since vitest's forks pool gives every test file a process of its own,
 * that was one directory per file — about 170 a run, and 46,044 leftover
 * `ralph-test-config-*` directories by the time `/tmp` reached 99% of its
 * inodes (#271). Keying the name by pid would not have helped: the pid is per
 * file here, not per worker.
 *
 * `fileScratchDir` is the right tool rather than a bare `rmSync`: every server
 * a suite spawns writes into this directory, so it is the most child-contended
 * scratch in the run, and `#187`'s `ENOTEMPTY` would otherwise red a passing
 * file on its own cleanup. A setup file runs inside each test file's own module
 * graph, so the `afterAll` it registers belongs to that file.
 */
import { fileScratchDir } from "./test-scratch";

process.env.XDG_CONFIG_HOME = fileScratchDir("ralph-test-config-");
