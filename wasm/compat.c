// Compatibility shims for building Redis server to WASM without check tools
// Provide missing globals and stubs that are normally defined by optional
// components (redis-check tools, TLS, threads manager, etc.).

#include "server.h"
#include <sys/resource.h>
#include <string.h>

// Used by rdb.c when compiled outside redis-check-rdb
int rdbCheckMode = 0;

// TLS connection type registration stub: not supported in our WASM build
int RedisRegisterConnectionTypeTLS(void) { return C_ERR; }

int getrusage(int who, struct rusage *usage) {
    (void)who;
    if (usage) memset(usage, 0, sizeof(*usage));
    return 0;
}
