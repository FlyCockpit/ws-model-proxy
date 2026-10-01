# Vendored libfuse 3.14.0 headers (test support only)

These four headers are byte-identical copies of the files of the same name in
https://github.com/libfuse/libfuse at tag `fuse-3.14.0`, directory `include/`.
The license text is `LGPL2.txt` from the same tag. The headers are LGPL-2.1
("This program can be distributed under the terms of the GNU LGPLv2"); keep their notices.

`fuse_config.h` and `libfuse_config.h` are the two build-time config headers that
libfuse's meson build generates, written by hand with only the macros the headers
need (project files, not upstream copies).

They are used only to COMPILE `../fuse-exchangeless.c`, the test daemon behind the
`exchangeless-fs` CI job and `scripts/test-exchangeless-fs.sh`. The daemon links the
runtime `libfuse3.so.3` that the CI image provides. Nothing here is built into, linked
into or shipped with the `wsmp` binary, a release artifact or a container image.

SHA-256:
```
283086be3cb44e27331029cd220319009487e955f661ca39e2ff7fd04c7abcec  fuse.h
41e5bda1724deda46a213ea237461323801d6256ec8f9756e19a0c73b20ea608  fuse_common.h
472c9ee7a84bb9c20e58957a3ff47f34c18b4a159ad63b4db7f90aad1e8ff4ce  fuse_opt.h
7f79a177c6ad78e0c5b5e3773c9e923286308c1dba1ece3a22cb278299d9bcdc  fuse_log.h
dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551  LGPL2.txt
```
