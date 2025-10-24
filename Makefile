# Build Redis + shim to WebAssembly via Emscripten
# Requirements:
#   - Install emscripten SDK (emsdk)
#   - Activate env: source /path/to/emsdk_env.sh
# Usage:
#   make          # builds out/redis.js + out/redis.wasm
#   make clean

EMCC ?= emcc
EMXX ?= em++
OUTDIR := build
BUILDDIR := node_modules/.cache/build
TARGET_JS := $(OUTDIR)/redis.js
TARGET_WASM := $(OUTDIR)/redis.wasm
RELEASE_HDR := $(REDIS_SRC)/release.h

# We use growth to accommodate Redis allocations, disable FS and sockets usage
BASE_EM_FLAGS := \
    -O3 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s ENVIRONMENT=node \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s NO_EXIT_RUNTIME=1 \
    -s ASSERTIONS=2 \
    -s SAFE_HEAP=1 \
    -s SUPPORT_LONGJMP=1 \
    -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
    -DHDR_MALLOC_INCLUDE=\"hdr_redis_malloc.h\" \
    -s EXPORTED_FUNCTIONS='["_malloc","_free","_redis_init","_redis_exec","_redis_free","_redis_create_handle","_redis_client_feed","_redis_client_read","_redis_client_free","_redis_client_wants_close"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue","HEAPU8","HEAP8","wasmMemory","stringToUTF8","lengthBytesUTF8","writeArrayToMemory"]'

# Allow callers to append flags without clobbering the defaults
EXTRA_EM_FLAGS ?=
EM_FLAGS := $(BASE_EM_FLAGS) -s STACK_SIZE=1048576 $(EXTRA_EM_FLAGS) --source-map-base=\"vendor/redis\"

REDIS_SRC := vendor/redis/src
DEPS_DIR := vendor/redis/deps

INCLUDES := \
    -I$(REDIS_SRC) \
    -I$(DEPS_DIR)/hiredis \
    -I$(DEPS_DIR)/linenoise \
    -I$(DEPS_DIR)/lua/src \
    -I$(DEPS_DIR)/hdr_histogram \
    -I$(DEPS_DIR)/fpconv \
    -I$(DEPS_DIR)/fast_float

# Gather Redis sources. We exclude standalone tools and TLS module.
REDIS_SOURCES := \
	$(REDIS_SRC)/adlist.c \
	$(REDIS_SRC)/quicklist.c \
	$(REDIS_SRC)/ae.c \
	$(REDIS_SRC)/anet.c \
	$(REDIS_SRC)/dict.c \
	$(REDIS_SRC)/ebuckets.c \
	$(REDIS_SRC)/eventnotifier.c \
	$(REDIS_SRC)/iothread.c \
	$(REDIS_SRC)/mstr.c \
	$(REDIS_SRC)/kvstore.c \
	$(REDIS_SRC)/server.c \
	$(REDIS_SRC)/sds.c \
	$(REDIS_SRC)/zmalloc.c \
	$(REDIS_SRC)/lzf_c.c \
	$(REDIS_SRC)/lzf_d.c \
	$(REDIS_SRC)/pqsort.c \
	$(REDIS_SRC)/zipmap.c \
	$(REDIS_SRC)/sha1.c \
	$(REDIS_SRC)/ziplist.c \
	$(REDIS_SRC)/release.c \
	$(REDIS_SRC)/networking.c \
	$(REDIS_SRC)/util.c \
	$(REDIS_SRC)/object.c \
	$(REDIS_SRC)/db.c \
	$(REDIS_SRC)/replication.c \
	$(REDIS_SRC)/rdb.c \
	$(REDIS_SRC)/t_string.c \
	$(REDIS_SRC)/t_list.c \
	$(REDIS_SRC)/t_set.c \
	$(REDIS_SRC)/t_zset.c \
	$(REDIS_SRC)/t_hash.c \
	$(REDIS_SRC)/config.c \
	$(REDIS_SRC)/aof.c \
	$(REDIS_SRC)/pubsub.c \
	$(REDIS_SRC)/multi.c \
	$(REDIS_SRC)/debug.c \
	$(REDIS_SRC)/sort.c \
	$(REDIS_SRC)/intset.c \
	$(REDIS_SRC)/syncio.c \
	$(REDIS_SRC)/cluster.c \
	$(REDIS_SRC)/cluster_legacy.c \
	$(REDIS_SRC)/cluster_slot_stats.c \
	$(REDIS_SRC)/crc16.c \
	$(REDIS_SRC)/endianconv.c \
	$(REDIS_SRC)/slowlog.c \
	$(REDIS_SRC)/eval.c \
	$(REDIS_SRC)/bio.c \
	$(REDIS_SRC)/rio.c \
	$(REDIS_SRC)/rand.c \
	$(REDIS_SRC)/memtest.c \
	$(REDIS_SRC)/syscheck.c \
	$(REDIS_SRC)/crcspeed.c \
	$(REDIS_SRC)/crccombine.c \
	$(REDIS_SRC)/crc64.c \
	$(REDIS_SRC)/bitops.c \
	$(REDIS_SRC)/sentinel.c \
	$(REDIS_SRC)/notify.c \
	$(REDIS_SRC)/setproctitle.c \
	$(REDIS_SRC)/blocked.c \
	$(REDIS_SRC)/hyperloglog.c \
	$(REDIS_SRC)/latency.c \
	$(REDIS_SRC)/sparkline.c \
	$(REDIS_SRC)/geo.c \
	$(REDIS_SRC)/lazyfree.c \
	$(REDIS_SRC)/module.c \
	$(REDIS_SRC)/evict.c \
	$(REDIS_SRC)/expire.c \
	$(REDIS_SRC)/geohash.c \
	$(REDIS_SRC)/geohash_helper.c \
	$(REDIS_SRC)/childinfo.c \
	$(REDIS_SRC)/defrag.c \
	$(REDIS_SRC)/siphash.c \
	$(REDIS_SRC)/rax.c \
	$(REDIS_SRC)/t_stream.c \
	$(REDIS_SRC)/listpack.c \
	$(REDIS_SRC)/localtime.c \
	$(REDIS_SRC)/acl.c \
	$(REDIS_SRC)/tracking.c \
	$(REDIS_SRC)/socket.c \
	$(REDIS_SRC)/sha256.c \
	$(REDIS_SRC)/timeout.c \
	$(REDIS_SRC)/threads_mngr.c \
	$(REDIS_SRC)/setcpuaffinity.c \
	$(REDIS_SRC)/monotonic.c \
	$(REDIS_SRC)/mt19937-64.c \
	$(REDIS_SRC)/resp_parser.c \
	$(REDIS_SRC)/call_reply.c \
	$(REDIS_SRC)/script_lua.c \
	$(REDIS_SRC)/script.c \
	$(REDIS_SRC)/functions.c \
	$(REDIS_SRC)/function_lua.c \
	$(REDIS_SRC)/commands.c \
	$(REDIS_SRC)/strl.c \
	$(REDIS_SRC)/connection.c \
	$(REDIS_SRC)/unix.c \
	$(REDIS_SRC)/logreqres.c

# Add deps that Redis expects as static compilation
DEPS_SOURCES := \
	$(DEPS_DIR)/hiredis/alloc.c \
	$(DEPS_DIR)/hiredis/async.c \
	$(DEPS_DIR)/hiredis/hiredis.c \
	$(DEPS_DIR)/hiredis/net.c \
	$(DEPS_DIR)/hiredis/read.c \
	$(DEPS_DIR)/linenoise/linenoise.c \
	$(DEPS_DIR)/hdr_histogram/hdr_histogram.c \
	$(DEPS_DIR)/fpconv/fpconv_dtoa.c \
	$(DEPS_DIR)/lua/src/lapi.c \
	$(DEPS_DIR)/lua/src/lcode.c \
	$(DEPS_DIR)/lua/src/ldebug.c \
	$(DEPS_DIR)/lua/src/ldo.c \
	$(DEPS_DIR)/lua/src/ldump.c \
	$(DEPS_DIR)/lua/src/lfunc.c \
	$(DEPS_DIR)/lua/src/lgc.c \
	$(DEPS_DIR)/lua/src/llex.c \
	$(DEPS_DIR)/lua/src/lmem.c \
	$(DEPS_DIR)/lua/src/lobject.c \
	$(DEPS_DIR)/lua/src/lopcodes.c \
	$(DEPS_DIR)/lua/src/lparser.c \
	$(DEPS_DIR)/lua/src/lstate.c \
	$(DEPS_DIR)/lua/src/lstring.c \
	$(DEPS_DIR)/lua/src/ltable.c \
	$(DEPS_DIR)/lua/src/ltm.c \
	$(DEPS_DIR)/lua/src/lundump.c \
	$(DEPS_DIR)/lua/src/lvm.c \
	$(DEPS_DIR)/lua/src/lzio.c \
	$(DEPS_DIR)/lua/src/lauxlib.c \
	$(DEPS_DIR)/lua/src/lbaselib.c \
	$(DEPS_DIR)/lua/src/ldblib.c \
	$(DEPS_DIR)/lua/src/liolib.c \
	$(DEPS_DIR)/lua/src/lmathlib.c \
	$(DEPS_DIR)/lua/src/loadlib.c \
	$(DEPS_DIR)/lua/src/loslib.c \
	$(DEPS_DIR)/lua/src/lstrlib.c \
	$(DEPS_DIR)/lua/src/ltablib.c \
	$(DEPS_DIR)/lua/src/lua_cjson.c \
	$(DEPS_DIR)/lua/src/lua_cmsgpack.c \
	$(DEPS_DIR)/lua/src/lua_struct.c \
	$(DEPS_DIR)/lua/src/lua_bit.c \
	$(DEPS_DIR)/lua/src/fpconv.c \
	$(DEPS_DIR)/lua/src/strbuf.c \
	$(DEPS_DIR)/hiredis/sds.c

SHIM := wasm/shim.c
COMPAT := wasm/compat.c
FAST_FLOAT_CPP := $(DEPS_DIR)/fast_float/fast_float_strtod.cpp

SOURCES := $(REDIS_SOURCES) $(DEPS_SOURCES) $(SHIM) $(COMPAT) $(FAST_FLOAT_CPP)

# Per-file objects under build/ preserving relative paths to avoid name clashes
C_OBJS := $(patsubst %.c,$(BUILDDIR)/%.o,$(filter %.c,$(SOURCES)))
CPP_OBJS := $(patsubst %.cpp,$(BUILDDIR)/%.o,$(filter %.cpp,$(SOURCES)))
OBJS := $(C_OBJS) $(CPP_OBJS)

# Compile-time flags for objects (keep defines used by sources)
CFLAGS ?= -O3 $(INCLUDES) -DHDR_MALLOC_INCLUDE=\"hdr_redis_malloc.h\" -DENABLE_CJSON_GLOBAL
CXXFLAGS ?= -O3 -std=c++17 $(INCLUDES) -DHDR_MALLOC_INCLUDE=\"hdr_redis_malloc.h\" -DENABLE_CJSON_GLOBAL

all: $(TARGET_JS)

$(OUTDIR):
	mkdir -p $(OUTDIR)

$(BUILDDIR):
	mkdir -p $(BUILDDIR)

$(TARGET_JS): $(OUTDIR) $(OBJS) $(RELEASE_HDR)
	$(EMCC) $(OBJS) $(EM_FLAGS) -o $(TARGET_JS)

$(RELEASE_HDR):
	cd $(REDIS_SRC) && sh ./mkreleasehdr.sh

# Object build rules
$(BUILDDIR)/%.o: %.c | $(BUILDDIR)
	@mkdir -p $(dir $@)
	$(EMCC) $(CFLAGS) -c $< -o $@

$(BUILDDIR)/%.o: %.cpp | $(BUILDDIR)
	@mkdir -p $(dir $@)
	$(EMXX) $(CXXFLAGS) -c $< -o $@

# Ensure release.c is rebuilt when release.h changes
$(BUILDDIR)/vendor/redis/src/release.o: $(RELEASE_HDR)

clean:
	rm -rf $(OUTDIR) $(BUILDDIR)

.PHONY: all clean
