// Doc Rephrase Helper.app launcher.
//
// Chrome starts this executable as the native messaging host. It runs the Python helper as a
// child process (stdin/stdout pass straight through) instead of exec'ing it, so this signed app
// bundle stays the "responsible" process. macOS then attributes the helper's 1Password access
// to "Doc Rephrase Helper" and remembers the user's Allow, which it does not do for bare
// command-line binaries such as python3.12 or op.
//
// APP_DIR is set at build time by install-helper.sh.
#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>

extern char **environ;

int main(void) {
    char *const argv[] = {APP_DIR "/venv/bin/python", "-I", APP_DIR "/doc_rephrase_host.py", NULL};
    pid_t pid;
    if (posix_spawn(&pid, argv[0], NULL, NULL, argv, environ) != 0) {
        perror("doc-rephrase-host: cannot start the Python helper");
        return 1;
    }
    int status;
    while (waitpid(pid, &status, 0) < 0) {}
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
