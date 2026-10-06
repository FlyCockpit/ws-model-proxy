/* Linux-only disposable test fixture. The Rust crate contains no unsafe FFI.
 * Fault the actual owning syscall once; no file bytes are logged. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <signal.h>
#include <sys/stat.h>

static int fired, restored, captured, written, removed, seen, slot_unlinked;
static char registry_parent[4096];

/* A test disarms every fault by creating this marker before follow-up edits. */
static int disarmed(void) {
    const char *marker = getenv("WSMP_DURABILITY_DISARM");
    return marker && !access(marker, F_OK);
}

static int fd_path(int fd, char *path, size_t size) {
    char proc[64];
    snprintf(proc, sizeof(proc), "/proc/self/fd/%d", fd);
    ssize_t n = readlink(proc, path, size - 1);
    if (n <= 0) return 0;
    path[n] = 0;
    return 1;
}

static int has_phase(const char *path, const char *phase) {
    char body[65536], needle[128];
    int input = open(path, O_RDONLY);
    if (input < 0 || !phase) { if (input >= 0) close(input); return 0; }
    ssize_t n = read(input, body, sizeof(body) - 1);
    close(input);
    if (n <= 0) return 0;
    body[n] = 0;
    snprintf(needle, sizeof(needle), "\"phase\":\"%s\"", phase);
    return strstr(body, needle) != NULL;
}

static int nth(void) {
    const char *value = getenv("WSMP_DURABILITY_NTH");
    return value ? atoi(value) : 1;
}

static int ends_with(const char *text, const char *suffix) {
    size_t a = strlen(text), b = strlen(suffix);
    return a >= b && !strcmp(text + a - b, suffix);
}

/* Disk full while the CLI writes a generated file: a short write, then ENOSPC. */
ssize_t write(int fd, const void *buffer, size_t count) {
    static ssize_t (*real)(int, const void *, size_t);
    if (!real) real = dlsym(RTLD_NEXT, "write");
    const char *fault = getenv("WSMP_DURABILITY_FAULT");
    char path[4096];
    if (fault && !disarmed() && fd > 2 && fd_path(fd, path, sizeof(path))) {
        int target = (!strcmp(fault, "enospc-tmp") && strstr(path, "/.wsmp-recover-")
                         && ends_with(path, "/tmp"))
            || (!strcmp(fault, "enospc-new") && ends_with(path, "/new"));
        if (target) {
            if (written++ == 0) return real(fd, buffer, count < 4 ? count : 4);
            errno = ENOSPC;
            return -1;
        }
    }
    return real(fd, buffer, count);
}

static void boundary(const char *name) {
    const char *selected = getenv("WSMP_DURABILITY_KILL");
    const char *marker = getenv("WSMP_DURABILITY_MARKER");
    if (selected && marker && !strcmp(selected, name)) {
        int fd = open(marker, O_CREAT | O_WRONLY, 0600);
        if (fd >= 0) { (void)write(fd, name, strlen(name)); close(fd); }
        raise(SIGSTOP);
    }
}

int renameat2(int oldfd, const char *old, int newfd, const char *new, unsigned flags) {
    static int (*real)(int, const char *, int, const char *, unsigned);
    if (!real) real = dlsym(RTLD_NEXT, "renameat2");
    int result = real(oldfd, old, newfd, new, flags);
    if (!result && !strcmp(old, "slot-1")) {
        restored = 1; boundary("after-restore");
    }
    if (!result && !strncmp(new, "slot-", 5)) {
        captured = 1; boundary("after-capture");
    }
    if (!result && flags == 2) boundary("after-exchange");
    return result;
}

int renameat(int oldfd, const char *old, int newfd, const char *new) {
    static int (*real)(int, const char *, int, const char *);
    if (!real) real = dlsym(RTLD_NEXT, "renameat");
    int result = real(oldfd, old, newfd, new);
    if (!result && !strcmp(old, "INTENT.new")) boundary("after-intent-rename");
    const char *fault = getenv("WSMP_DURABILITY_FAULT");
    if (!result && fault && !disarmed() && !strcmp(fault, "kill-after-phase")
        && !strcmp(old, "INTENT.new")) {
        char path[4096];
        if (fd_path(newfd, path, sizeof(path) - 8)) {
            strcat(path, "/INTENT");
            /* Process death right after this phase became the durable journal. */
            if (has_phase(path, getenv("WSMP_DURABILITY_PHASE"))) raise(SIGKILL);
        }
    }
    return result;
}

int unlinkat(int fd, const char *name, int flags) {
    static int (*real)(int, const char *, int);
    if (!real) real = dlsym(RTLD_NEXT, "unlinkat");
    int result = real(fd, name, flags);
    if (!result && !strncmp(name, ".wsmp-pin-", 10)) boundary("after-pin-unlink");
    if (!result && (flags & AT_REMOVEDIR) && !strncmp(name, ".wsmp-recover-", 14)) removed = 1;
    if (!result && !strncmp(name, "slot-", 5)) slot_unlinked = 1;
    return result;
}

int fsync(int fd) {
    static int (*real)(int);
    if (!real) real = dlsym(RTLD_NEXT, "fsync");
    char path[4096], body[65536];
    ssize_t n;
    if (!fd_path(fd, path, sizeof(path))) return real(fd);
    const char *fault = disarmed() ? NULL : getenv("WSMP_DURABILITY_FAULT");
    struct stat info;
    /* Only the directory named in the target file (the CLI state directory). */
    if (fault && !strcmp(fault, "listed-dir-einval")) {
        const char *target_file = getenv("WSMP_DURABILITY_TARGET");
        char target[4096];
        int input = target_file ? open(target_file, O_RDONLY) : -1;
        if (input >= 0) {
            ssize_t got = read(input, target, sizeof(target) - 1);
            close(input);
            if (got > 0) {
                target[got] = 0;
                if (!strcmp(path, target)) { errno = EINVAL; return -1; }
            }
        }
    }
    /* A filesystem without directory fsync: every directory answers EINVAL. */
    if (fault && !strcmp(fault, "dir-einval") && !fstat(fd, &info) && S_ISDIR(info.st_mode)) {
        errno = EINVAL;
        return -1;
    }
    if (strstr(path, ".json.tmp")) {
        snprintf(registry_parent, sizeof(registry_parent), "%s", path);
        char *last = strrchr(registry_parent, '/');
        if (last) *last = 0;
    }
    int fail = 0;
    if (!fired && fault) {
        if (!strcmp(fault, "registry-write") && strstr(path, ".json.tmp")) fail = 1;
        if (!strcmp(fault, "registry-dir") && registry_parent[0] && !strcmp(path, registry_parent)) fail = 1;
        if (!strcmp(fault, "restore-parent") && restored && !strstr(path, ".wsmp-recover-")) fail = 1;
        if (!strcmp(fault, "capture-parent") && captured && !strstr(path, ".wsmp-recover-")) fail = 1;
        if (!strcmp(fault, "slot-data") && captured && strstr(path, "/slot-1")) fail = 1;
        if (!strcmp(fault, "rmdir-parent") && removed) fail = 1;
        if (!strcmp(fault, "intent-nth") && strstr(path, "/INTENT.new")
            && has_phase(path, getenv("WSMP_DURABILITY_PHASE")) && ++seen == nth()) fail = 1;
        if (strstr(path, "/.wsmp-recover-") && !fstat(fd, &info) && S_ISDIR(info.st_mode)) {
            if (!strcmp(fault, "rdir-nth") && ++seen == nth()) fail = 1;
            if (!strcmp(fault, "rdir-after-slot-unlink") && slot_unlinked) fail = 1;
        }
        if (!strncmp(fault, "intent-", 7) && strcmp(fault, "intent-nth") && strstr(path, "/INTENT.new")) {
            int input = open(path, O_RDONLY);
            if (input >= 0) {
                n = read(input, body, sizeof(body) - 1); close(input);
                if (n > 0) {
                    body[n] = 0;
                    char phase[128];
                    snprintf(phase, sizeof(phase), "\"phase\":\"%s\"", fault + 7);
                    fail = strstr(body, phase) != NULL;
                }
            }
        }
    }
    if (fail) { fired = 1; errno = EIO; return -1; }
    const char *stall = getenv("WSMP_DURABILITY_STALL");
    if (!fired && stall && strstr(path, "/.wsmp-recover-") && strstr(path, "/tmp")) {
        size_t length = strlen(path);
        if (length >= 4 && !strcmp(path + length - 4, "/tmp")) {
            fired = 1;
            int marker = open(stall, O_CREAT | O_WRONLY, 0600);
            if (marker >= 0) close(marker);
            const char *release = getenv("WSMP_DURABILITY_RELEASE");
            while (release && access(release, F_OK)) usleep(1000);
        }
    }
    int result = real(fd);
    if (!result && strstr(path, "/INTENT.new")) boundary("after-intent-fsync");
    if (!result && restored && !strstr(path, ".wsmp-recover-")) boundary("after-public-barrier");
    return result;
}
