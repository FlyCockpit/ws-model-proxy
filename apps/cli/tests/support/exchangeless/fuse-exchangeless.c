/*
 * Test-only FUSE passthrough daemon for the wsmp exchange-less file tests.
 *
 * It forwards every operation to a backing directory, but refuses what real
 * exchange-less filesystems refuse, so the file tools' fallback paths run on a
 * REAL mount (not only by fault injection):
 *   - rename flags RENAME_EXCHANGE (2): always EINVAL;
 *   - PROBE_NO_NOREPLACE: RENAME_NOREPLACE (1) is EINVAL;
 *   - PROBE_NO_LINK: link() is EPERM;
 *   - PROBE_NO_INO: no stable inode numbers (`use_ino` off, so two names of one
 *     object report different st_ino).
 * Entry, attribute and negative-lookup caching is off, so every observation
 * reaches the backing directory.
 *
 * Build (see scripts/test-exchangeless-fs.sh):
 *   gcc -std=gnu11 -D_FILE_OFFSET_BITS=64 -I vendor/libfuse3 fuse-exchangeless.c \
 *       -Wl,-l:libfuse3.so.3 -o fuse-exchangeless
 * Run: PROBE_BACKING=<dir> [PROBE_NO_*=1] fuse-exchangeless -f -s <mountpoint>
 */
#define FUSE_USE_VERSION 31
#define _GNU_SOURCE
#include "fuse.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define RENAME_NOREPLACE_FLAG 1U
#define RENAME_EXCHANGE_FLAG 2U

static char base[PATH_MAX];
static int reject_noreplace, reject_link, no_ino;

/* Join the backing directory and a mount-relative path; refuse truncation. */
static int join(char *out, const char *path)
{
	int n = snprintf(out, PATH_MAX, "%s%s", base, path);
	return (n < 0 || n >= PATH_MAX) ? -ENAMETOOLONG : 0;
}

#define WITH_PATH(var, path)                                                   \
	char var[PATH_MAX];                                                    \
	do {                                                                   \
		int rc_ = join(var, path);                                     \
		if (rc_)                                                       \
			return rc_;                                            \
	} while (0)

static int op_getattr(const char *p, struct stat *s, struct fuse_file_info *f)
{
	(void)f;
	WITH_PATH(a, p);
	return lstat(a, s) ? -errno : 0;
}

static int op_mkdir(const char *p, mode_t m)
{
	WITH_PATH(a, p);
	return mkdir(a, m) ? -errno : 0;
}

static int op_unlink(const char *p)
{
	WITH_PATH(a, p);
	return unlink(a) ? -errno : 0;
}

static int op_rmdir(const char *p)
{
	WITH_PATH(a, p);
	return rmdir(a) ? -errno : 0;
}

static int op_rename(const char *p, const char *q, unsigned flags)
{
	WITH_PATH(a, p);
	WITH_PATH(b, q);
	if (flags & RENAME_EXCHANGE_FLAG)
		return -EINVAL;
	if ((flags & RENAME_NOREPLACE_FLAG) && reject_noreplace)
		return -EINVAL;
	return renameat2(AT_FDCWD, a, AT_FDCWD, b, flags) ? -errno : 0;
}

static int op_link(const char *p, const char *q)
{
	if (reject_link)
		return -EPERM;
	WITH_PATH(a, p);
	WITH_PATH(b, q);
	return link(a, b) ? -errno : 0;
}

static int op_symlink(const char *target, const char *q)
{
	WITH_PATH(b, q);
	return symlink(target, b) ? -errno : 0;
}

static int op_readlink(const char *p, char *buf, size_t size)
{
	WITH_PATH(a, p);
	ssize_t n = readlink(a, buf, size - 1);
	if (n < 0)
		return -errno;
	buf[n] = 0;
	return 0;
}

static int op_open(const char *p, struct fuse_file_info *f)
{
	WITH_PATH(a, p);
	int fd = open(a, f->flags);
	if (fd < 0)
		return -errno;
	f->fh = (uint64_t)fd;
	return 0;
}

static int op_create(const char *p, mode_t m, struct fuse_file_info *f)
{
	WITH_PATH(a, p);
	int fd = open(a, f->flags | O_CREAT, m);
	if (fd < 0)
		return -errno;
	f->fh = (uint64_t)fd;
	return 0;
}

static int op_read(const char *p, char *buf, size_t size, off_t off,
		   struct fuse_file_info *f)
{
	(void)p;
	ssize_t n = pread((int)f->fh, buf, size, off);
	return n < 0 ? -errno : (int)n;
}

static int op_write(const char *p, const char *buf, size_t size, off_t off,
		    struct fuse_file_info *f)
{
	(void)p;
	ssize_t n = pwrite((int)f->fh, buf, size, off);
	return n < 0 ? -errno : (int)n;
}

static int op_release(const char *p, struct fuse_file_info *f)
{
	(void)p;
	return close((int)f->fh) ? -errno : 0;
}

static int op_truncate(const char *p, off_t size, struct fuse_file_info *f)
{
	WITH_PATH(a, p);
	return (f ? ftruncate((int)f->fh, size) : truncate(a, size)) ? -errno : 0;
}

static int op_chmod(const char *p, mode_t m, struct fuse_file_info *f)
{
	WITH_PATH(a, p);
	return (f ? fchmod((int)f->fh, m) : chmod(a, m)) ? -errno : 0;
}

static int op_chown(const char *p, uid_t u, gid_t g, struct fuse_file_info *f)
{
	WITH_PATH(a, p);
	return (f ? fchown((int)f->fh, u, g) : lchown(a, u, g)) ? -errno : 0;
}

static int op_fsync(const char *p, int datasync, struct fuse_file_info *f)
{
	(void)p;
	(void)datasync;
	return fsync((int)f->fh) ? -errno : 0;
}

static int op_readdir(const char *p, void *buf, fuse_fill_dir_t fill, off_t off,
		      struct fuse_file_info *fi, enum fuse_readdir_flags fl)
{
	(void)off;
	(void)fi;
	(void)fl;
	WITH_PATH(a, p);
	DIR *d = opendir(a);
	if (!d)
		return -errno;
	struct dirent *e;
	while ((e = readdir(d))) {
		struct stat st;
		memset(&st, 0, sizeof st);
		st.st_ino = e->d_ino;
		st.st_mode = (mode_t)e->d_type << 12;
		if (fill(buf, e->d_name, &st, 0, 0))
			break;
	}
	closedir(d);
	return 0;
}

static int op_utimens(const char *p, const struct timespec tv[2],
		      struct fuse_file_info *f)
{
	(void)f;
	WITH_PATH(a, p);
	return utimensat(AT_FDCWD, a, tv, AT_SYMLINK_NOFOLLOW) ? -errno : 0;
}

static void *op_init(struct fuse_conn_info *c, struct fuse_config *cfg)
{
	(void)c;
	cfg->use_ino = !no_ino;
	cfg->entry_timeout = 0;
	cfg->attr_timeout = 0;
	cfg->negative_timeout = 0;
	return NULL;
}

int main(int argc, char **argv)
{
	const char *backing = getenv("PROBE_BACKING");
	if (!backing || !*backing) {
		fprintf(stderr, "PROBE_BACKING is required\n");
		return 2;
	}
	if (snprintf(base, sizeof base, "%s", backing) >= (int)sizeof base) {
		fprintf(stderr, "PROBE_BACKING is too long\n");
		return 2;
	}
	reject_noreplace = getenv("PROBE_NO_NOREPLACE") != NULL;
	reject_link = getenv("PROBE_NO_LINK") != NULL;
	no_ino = getenv("PROBE_NO_INO") != NULL;
	static const struct fuse_operations ops = {
		.getattr = op_getattr,
		.mkdir = op_mkdir,
		.unlink = op_unlink,
		.rmdir = op_rmdir,
		.rename = op_rename,
		.link = op_link,
		.symlink = op_symlink,
		.readlink = op_readlink,
		.open = op_open,
		.create = op_create,
		.read = op_read,
		.write = op_write,
		.release = op_release,
		.truncate = op_truncate,
		.chmod = op_chmod,
		.chown = op_chown,
		.fsync = op_fsync,
		.readdir = op_readdir,
		.utimens = op_utimens,
		.init = op_init,
	};
	return fuse_main(argc, argv, &ops, NULL);
}
