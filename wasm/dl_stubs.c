#include <stddef.h>

void *dlopen(const char *path, int mode) {
  (void)path; (void)mode; return NULL;
}
void *dlsym(void *handle, const char *symbol) {
  (void)handle; (void)symbol; return NULL;
}
int dlclose(void *handle) {
  (void)handle; return 0;
}
char *dlerror(void) {
  return "dl not supported";
}
