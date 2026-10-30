// Runs a command as its own "responsible" process (Doc Rephrase uses it for `op`).
//
// `op` reaches the 1Password app through 1Password's protected app-group folder. macOS asks the
// responsible process for permission ("would like to access data from other apps") and doesn't
// remember the answer for this ad-hoc-signed helper. Run on its own, `op` is checked as itself:
// it is signed by 1Password's own team, which owns that folder, so no prompt is needed.
#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>

extern char **environ;
int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: run-as-own <program> [args...]\n"); return 2; }
    posix_spawnattr_t attrs;
    posix_spawnattr_init(&attrs);
    responsibility_spawnattrs_setdisclaim(&attrs, 1);
    pid_t pid;
    if (posix_spawn(&pid, argv[1], NULL, &attrs, argv + 1, environ) != 0) {
        perror("run-as-own: cannot start the program");
        return 1;
    }
    int status;
    while (waitpid(pid, &status, 0) < 0) {}
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
