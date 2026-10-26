# Local keyword detector assets

These files serve the opt-in voice privacy keywords. `kws.worker.js` and `capture.worklet.js` are ours. Everything in `vendor/` is third-party and pinned by SHA-256 in `manifest.json`. The page checks every vendor file against it, including the two glue scripts the worker loads with `importScripts`, before starting the worker. The manifest is served from the same origin, so this catches corruption and version skew, not a tampered host. Notices are in `THIRD_PARTY_NOTICES.txt`.

## Engine: `vendor/sherpa-onnx-wasm-kws-main.{js,wasm}` and `vendor/sherpa-onnx-kws.js`

sherpa-onnx publishes no browser KWS WebAssembly build for v2.0.0. Its npm `sherpa-onnx@2.0.0` package is Node-only (NODERAWFS). These files are built from the official source:

```sh
git clone --depth 1 --branch v2.0.0 https://github.com/k2-fsa/sherpa-onnx.git   # 8abb7c8f87eae85b2e75f9a4115236c978980add
git clone https://github.com/emscripten-core/emsdk.git && cd emsdk && ./emsdk install 4.0.23 && ./emsdk activate 4.0.23 && source ./emsdk_env.sh && cd ..
cd sherpa-onnx && git apply ../kws-no-preload.patch   # the diff below
./build-wasm-simd-kws.sh   # needs cmake; downloads its hash-pinned onnxruntime-wasm-static_lib-simd-1.28.2
cp build-wasm-simd-kws/install/bin/wasm/sherpa-onnx-wasm-kws-main.{js,wasm} build-wasm-simd-kws/install/bin/wasm/sherpa-onnx-kws.js <this dir>/vendor/
```

The result is single-threaded SIMD with 512 MiB of initial, unshared memory, so the page needs no cross-origin isolation. The patch drops the preloaded `.data` package, because the parent supplies the model bytes, and it exports `FS`:

```diff
diff --git a/wasm/kws/CMakeLists.txt b/wasm/kws/CMakeLists.txt
index 031bd6d..fbfe9ba 100644
--- a/wasm/kws/CMakeLists.txt
+++ b/wasm/kws/CMakeLists.txt
@@ -2,10 +2,7 @@ if(NOT $ENV{SHERPA_ONNX_IS_USING_BUILD_WASM_SH})
     message(FATAL_ERROR "Please use ./build-wasm-simd-kws.sh to build for wasm KWS")
 endif()

-if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/assets/decoder-epoch-12-avg-2-chunk-16-left-64.onnx")
-    message(WARNING "${CMAKE_CURRENT_SOURCE_DIR}/assets/decoder-epoch-12-avg-2-chunk-16-left-64.onnx does not exist")
-    message(FATAL_ERROR "Please read ${CMAKE_CURRENT_SOURCE_DIR}/assets/README.md before you continue")
-endif()
+# T3: model bytes are supplied at runtime by the parent page; no preloaded .data package.

 set(exported_functions
   SherpaOnnxCreateKeywordSpotter
@@ -33,8 +30,7 @@ include_directories(${CMAKE_SOURCE_DIR})
 set(MY_FLAGS "-s FORCE_FILESYSTEM=1 -s INITIAL_MEMORY=512MB -s ALLOW_MEMORY_GROWTH=1")
 string(APPEND MY_FLAGS " -sSTACK_SIZE=10485760 ")
 string(APPEND MY_FLAGS " -sEXPORTED_FUNCTIONS=[_CopyHeap,_malloc,_free,${all_exported_functions}] ")
-string(APPEND MY_FLAGS "--preload-file ${CMAKE_CURRENT_SOURCE_DIR}/assets@. ")
-string(APPEND MY_FLAGS " -sEXPORTED_RUNTIME_METHODS=['ccall','stringToUTF8','setValue','getValue','lengthBytesUTF8','UTF8ToString','HEAPU8','HEAP16','HEAP32','HEAPU32','HEAPF32','HEAPF64'] ")
+string(APPEND MY_FLAGS " -sEXPORTED_RUNTIME_METHODS=['ccall','stringToUTF8','setValue','getValue','lengthBytesUTF8','UTF8ToString','HEAPU8','HEAP16','HEAP32','HEAPU32','HEAPF32','HEAPF64','FS'] ")

 message(STATUS "MY_FLAGS: ${MY_FLAGS}")

@@ -53,7 +49,6 @@ install(
         "index.html"
         "$<TARGET_FILE_DIR:sherpa-onnx-wasm-kws-main>/sherpa-onnx-wasm-kws-main.js"
         "$<TARGET_FILE_DIR:sherpa-onnx-wasm-kws-main>/sherpa-onnx-wasm-kws-main.wasm"
-        "$<TARGET_FILE_DIR:sherpa-onnx-wasm-kws-main>/sherpa-onnx-wasm-kws-main.data"
         DESTINATION
         bin/wasm
 )
```

## Model: the `*.int8.onnx` files and `tokens.txt` in `vendor/`

These come from https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2, whose archive SHA-256 is `f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a`. The model's README declares Apache License 2.0. Only the int8 encoder, decoder and joiner and `tokens.txt` are shipped. The two phrases in `kws.worker.js` were tokenized with the archive's `bpe.model`.

## Worker CSP

The worker's response carries `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'`. `'wasm-unsafe-eval'` is there only to compile the engine, and it applies to this worker alone. Three places send this policy:

- the desktop protocol in `apps/desktop/src/electron/ElectronProtocol.ts`;
- the T3 server's static handler in `apps/server/src/http.ts`;
- the hosted web app in `apps/web/vercel.ts`.

The Vite dev server does not send it, so dev is unenforced.

Once initialised, the worker also replaces `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `WebTransport`, `importScripts` and `Worker` with `undefined`.
