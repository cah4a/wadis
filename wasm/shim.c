// Minimal shim to run Redis fully in-process and expose C-callable entrypoints
// WARNING: This assumes we run in a single-threaded WASM environment.
#include "server.h"
#include "script.h"
#include "resp_parser.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static connection g_fake_conn;
static client **g_clients = NULL;
static size_t g_clients_cap = 0;

/* Forward declarations from server.c that are not exposed in server.h */
void initServerConfig(void);
void initServer(void);
void redisOutOfMemoryHandler(size_t allocation_size);
client *moduleAllocTempClient(void);
void moduleReleaseTempClient(client *c);

static int g_initialized = 0;

static int do_redis_init(int set_level, int level) {
    if (g_initialized) return 0;
    static char *argv[] = { "redis-server", "--loglevel", "warning", "--protected-mode", "no", NULL };
    int argc = 5;

    (void)argv; (void)argc;

    tzset();
    zmalloc_set_oom_handler(redisOutOfMemoryHandler);

    initServerConfig();
    ACLInit();
    moduleInitModulesSystem();
    connTypeInitialize();

    server.port = 0;

    if (server.maxmemory == 0) {
        server.maxmemory = 256LL * (1024 * 1024);
        server.maxmemory_policy = MAXMEMORY_NO_EVICTION;
    }

    if (set_level) {
        if (level < LL_DEBUG) level = LL_DEBUG;
        if (level > LL_WARNING) level = LL_WARNING;
        server.verbosity = level;
    }

    initServer();
    g_initialized = 1;
    return 0;
}

// Initialize Redis server with minimal defaults and no networking listeners.
// Returns 0 on success, non-zero on failure. Idempotent.
int redis_init(int level) {
    return do_redis_init(1, level);
}

// Execute a RESP command buffer and return a newly allocated RESP reply buffer.
// in_ptr/in_len: input RESP bytes (e.g., *2\r\n$4\r\nPING\r\n$4\r\nPONG\r\n)
// *out_ptr/*out_len: set to a malloc'd buffer and its size containing a RESP reply.
// Returns 0 on success, non-zero error on failure.
int redis_exec(const unsigned char *in_ptr, size_t in_len, unsigned char **out_ptr, size_t *out_len) {
    if (!in_ptr || !out_ptr || !out_len) return 1;

    // Use a module temp client pattern to avoid sockets.
    client *c = moduleAllocTempClient();
    if (!c) return 2;

    // Provide a fake non-NULL connection pointer to satisfy memory tracking asserts.
    c->conn = &g_fake_conn;

    // Create query buffer
    c->querybuf = sdsnewlen((const char*)in_ptr, in_len);
    c->qb_pos = 0;

    // Process input buffer to parse and execute commands; this mimics networking.c path
    int rc = processInputBuffer(c);
    if (rc == C_ERR) {
        // client may have been freed, but typically processInputBuffer uses freeClientAsync
        // Try to build error
        if (server.current_client == NULL) {
            // cannot reply
            return 3;
        }
    }

    // At this point, replies are in c->buf / c->reply list
    sds proto = sdsnewlen(c->buf, c->bufpos);
    c->bufpos = 0;
    while(listLength(c->reply)) {
        clientReplyBlock *o = listNodeValue(listFirst(c->reply));
        proto = sdscatlen(proto, o->buf, o->used);
        listDelNode(c->reply, listFirst(c->reply));
    }

    // Allocate C buffer to return
    *out_len = sdslen(proto);
    *out_ptr = (unsigned char*)malloc(*out_len);
    if (!*out_ptr) {
        sdsfree(proto);
        moduleReleaseTempClient(c);
        return 4;
    }
    memcpy(*out_ptr, proto, *out_len);
    sdsfree(proto);

    // Reset or free client
    moduleReleaseTempClient(c);
    return 0;
}

// Free an output buffer allocated by redis_exec
void redis_free(unsigned char *ptr, size_t len) {
    (void)len;
    if (ptr) free(ptr);
}

int redis_create_handle(void) {
    client *c = moduleAllocTempClient();
    if (!c) return 0;
    c->conn = &g_fake_conn;
    if (g_clients_cap == 0) {
        g_clients_cap = 64;
        g_clients = (client**)calloc(g_clients_cap, sizeof(client*));
    }
    for (size_t i = 0; i < g_clients_cap; i++) {
        if (g_clients[i] == NULL) {
            g_clients[i] = c;
            return (int)(i + 1);
        }
    }
    size_t old = g_clients_cap;
    g_clients_cap = g_clients_cap * 2;
    g_clients = (client**)realloc(g_clients, g_clients_cap * sizeof(client*));
    memset(g_clients + old, 0, (g_clients_cap - old) * sizeof(client*));
    g_clients[old] = c;
    return (int)(old + 1);
}

int redis_client_feed(int handle, const unsigned char *in_ptr, size_t in_len) {
    if (handle <= 0) return 1;
    size_t idx = (size_t)handle - 1;
    if (idx >= g_clients_cap) return 2;
    client *c = g_clients[idx];
    if (!c) return 3;

    if (!c->querybuf) {
        c->querybuf = sdsnewlen((const char*)in_ptr, in_len);
        c->qb_pos = 0;
    } else {
        c->querybuf = sdscatlen(c->querybuf, in_ptr, in_len);
    }

    /* Avoid re-entrancy: if a command (or script) is currently executing on
     * this client, defer parsing until the execution is done. This prevents
     * processMultibulkBuffer() from asserting that c->argc == 0 while the
     * previous command argv is still populated. */
    if ((c->flags & CLIENT_EXECUTING_COMMAND) || scriptIsRunning()) {
        return 0;
    }

    int rc = processInputBuffer(c);
    if (rc == C_ERR && server.current_client == NULL) return 4;

    return 0;
}

int redis_client_read(int handle, unsigned char **out_ptr, size_t *out_len) {
    if (handle <= 0) return 1;
    size_t idx = (size_t)handle - 1;
    if (idx >= g_clients_cap) return 2;
    client *c = g_clients[idx];
    if (!c) return 3;

    /* If there's pending input buffered and we're not in the middle of
     * executing a command (or a script), process it now so replies are
     * available to read. */
    if (c->querybuf && sdslen(c->querybuf) > 0 &&
        !(c->flags & CLIENT_EXECUTING_COMMAND) && !scriptIsRunning())
    {
        int rc = processInputBuffer(c);
        if (rc == C_ERR && server.current_client == NULL) return 5;
    }

    size_t total = (size_t)c->bufpos;
    listIter li;
    listNode *ln;
    listRewind(c->reply, &li);
    while ((ln = listNext(&li)) != NULL) {
        clientReplyBlock *o = listNodeValue(ln);
        total += o->used;
    }
    if (total == 0) {
        *out_ptr = NULL;
        *out_len = 0;
        return 0;
    }
    unsigned char *buf = (unsigned char*)malloc(total);
    if (!buf) return 4;
    size_t pos = 0;
    if (c->bufpos) {
        memcpy(buf + pos, c->buf, c->bufpos);
        pos += c->bufpos;
        c->bufpos = 0;
    }
    while (listLength(c->reply)) {
        clientReplyBlock *o = listNodeValue(listFirst(c->reply));
        memcpy(buf + pos, o->buf, o->used);
        pos += o->used;
        listDelNode(c->reply, listFirst(c->reply));
    }
    *out_ptr = buf;
    *out_len = total;
    return 0;
}

void redis_client_free(int handle) {
    if (handle <= 0) return;
    size_t idx = (size_t)handle - 1;
    if (idx >= g_clients_cap) return;
    client *c = g_clients[idx];
    if (!c) return;
    g_clients[idx] = NULL;
    moduleReleaseTempClient(c);
}

int redis_client_wants_close(int handle) {
    if (handle <= 0) return 0;
    size_t idx = (size_t)handle - 1;
    if (idx >= g_clients_cap) return 0;
    client *c = g_clients[idx];
    if (!c) return 0;
    if (!(c->flags & CLIENT_CLOSE_AFTER_REPLY)) return 0;
    if (c->bufpos != 0) return 0;
    if (listLength(c->reply) != 0) return 0;
    return 1;
}
