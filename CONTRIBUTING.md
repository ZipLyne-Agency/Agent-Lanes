# Contributing

Issues and pull requests are welcome. A few things keep this project working:

- **Run the unit suites.** They need no Chrome:

  ```bash
  npm --prefix extension ci
  bash tests/test-extension.sh
  bash tests/test-browser-mcp-server.sh
  python3 -m unittest tests/test_native_bridge.py tests/test_install_extension.py tests/test_chrome_background_safe.py
  ```

- **Changes to lane state, focus, window creation, or cleanup need live proof.** Run the
  scripts in `tests/live/` with Chrome set up as in `docs/install.md`, and say in the pull
  request what you ran and what it showed. Unit tests cannot prove what macOS and Chrome do
  with focus.
- **Keep the invariants** in `docs/architecture.md`. Every one of them was learned from a
  live failure.
- **Say what is proven.** Docs distinguish "proven live" from "unit-tested" from
  "designed". Keep it that way.
