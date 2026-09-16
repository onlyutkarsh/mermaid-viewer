## [2.3.4](https://github.com/onlyutkarsh/mermaid-viewer/compare/v2.3.3...v2.3.4) (2026-09-16)


### Bug Fixes

* **syntax:** enhance ER diagram syntax support ([4824aeb](https://github.com/onlyutkarsh/mermaid-viewer/commit/4824aeb5129c908c456948c75a1b0ac82c944c80))



## [2.3.3](https://github.com/onlyutkarsh/mermaid-viewer/compare/v2.3.2...v2.3.3) (2026-09-15)



## [2.3.2](https://github.com/onlyutkarsh/mermaid-viewer/compare/v2.3.1...v2.3.2) (2026-09-12)


### Bug Fixes

* **build:** improve prepublish script to clean up output maps ([3d7a22f](https://github.com/onlyutkarsh/mermaid-viewer/commit/3d7a22f37eb592deac29354fefe8bcb7bf1f638b))



## [2.3.1](https://github.com/onlyutkarsh/mermaid-viewer/compare/v2.3.0...v2.3.1) (2026-09-12)


### Features

* **copy:** add option to copy Mermaid source with configurable wrapper ([a447ad6](https://github.com/onlyutkarsh/mermaid-viewer/commit/a447ad659cb7f182e709ff53c24fc959c7d53f94))



## [2.3.0](https://github.com/onlyutkarsh/mermaid-viewer/compare/v2.2.1...v2.3.0) (2026-09-12)


### Bug Fixes

* **ci:** improve Mermaid compatibility check output ([b488b0b](https://github.com/onlyutkarsh/mermaid-viewer/commit/b488b0bc16e44ec92c69221e829852f2134dfe9e))
* **ci:** improve upgrade message for Mermaid compatibility check ([91d0517](https://github.com/onlyutkarsh/mermaid-viewer/commit/91d051701c4b3ee10484d33fa73dc28611eedefe))
* **ci:** pin jsdom for Node 20 ([6bcfde1](https://github.com/onlyutkarsh/mermaid-viewer/commit/6bcfde13e92188a996365fdf9a59fa44bc54f7cd))
* **deps:** pin @vscode/codicons version to 0.0.45 ([4921d7b](https://github.com/onlyutkarsh/mermaid-viewer/commit/4921d7bce571608404731d7f80de7fd34d09535c))


### Features

* **rendering:** add rendering success logging and tests ([b639c19](https://github.com/onlyutkarsh/mermaid-viewer/commit/b639c19e84d486283c6ce950cbee16125fd58988))



## [2.2.1](https://github.com/onlyutkarsh/mermaid-viewer/compare/v2.2.0...v2.2.1) (2026-08-07)


### Features

* **ui:** enhance selection handling for diagram interactions ([5df9d7c](https://github.com/onlyutkarsh/mermaid-viewer/commit/5df9d7cb825cf604019ac0609a47b196e6404f82))



## [2.2.0](https://github.com/onlyutkarsh/mermaid-viewer/compare/v2.1.4...v2.2.0) (2026-07-30)


### Bug Fixes

* only clear annotations when diagrams actually change ([2f79ada](https://github.com/onlyutkarsh/mermaid-viewer/commit/2f79ada83bcff47e69fc61fbec28e05031f5ef6e))


### Features

* automatically clear annotations when diagram is edited ([9226a89](https://github.com/onlyutkarsh/mermaid-viewer/commit/9226a89a06ca69c840e45019feddf5a01227860f))
* **docs:** enhance README and add example diagrams ([f43fffd](https://github.com/onlyutkarsh/mermaid-viewer/commit/f43fffd13b3e212ea152011e604d3354f07f1e72))



## [2.1.4](https://github.com/onlyutkarsh/mermaid-viewer/compare/v2.1.3...v2.1.4) (2026-07-28)



## [2.1.3](https://github.com/onlyutkarsh/mermaid-viewer/compare/v2.1.2...v2.1.3) (2026-07-28)



## [2.1.2](https://github.com/onlyutkarsh/mermaid-viewer/compare/v2.1.1...v2.1.2) (2026-07-10)


### Performance Improvements

* debounce diagnostics/gutter, remove redundant parse and verbose logging ([163d18b](https://github.com/onlyutkarsh/mermaid-viewer/commit/163d18bc0ebf94309dbf7be8d784a03e5c6fcbf8))



## [2.1.1](https://github.com/onlyutkarsh/mermaid-viewer/compare/v2.1.0...v2.1.1) (2026-07-03)


### Features

* **preview:** enhance diagram error handling and rendering ([5b0650d](https://github.com/onlyutkarsh/mermaid-viewer/commit/5b0650d0f1f1b867e2831a6a22d3baddfc9e919a))



## [2.1.0](https://github.com/onlyutkarsh/mermaid-viewer/compare/24527279f9c51decac028c75ae82dcbe5b8c481e...v2.1.0) (2026-07-02)


### Bug Fixes

* add command to copy Mermaid diagram code in MermaidCodeLensProvider ([87e9077](https://github.com/onlyutkarsh/mermaid-viewer/commit/87e9077aa67f259d2cda692421ec5eb04266979f))
* enhance cursor styles for SVG elements in MermaidPreviewPanel ([36591d6](https://github.com/onlyutkarsh/mermaid-viewer/commit/36591d6186714fbdece87a2ea0b5429815c439ec))
* enhance panning functionality and improve cursor styles in MermaidPreviewPanel ([6528034](https://github.com/onlyutkarsh/mermaid-viewer/commit/6528034b0238f9ff1b90522c4212f42b579c3f23))
* enhance webview security and error handling in MermaidPreviewPanel and package mermaid properly ([5e7c77e](https://github.com/onlyutkarsh/mermaid-viewer/commit/5e7c77e0fdad6ea6b16c31ccf889a8051fdacde9))
* improve cursor handling during panning in MermaidPreviewPanel ([c95a867](https://github.com/onlyutkarsh/mermaid-viewer/commit/c95a8670749c354a8b48301a6421cd5c3d37bdea))
* improve disposal handling and enhance toolbar control bindings in MermaidPreviewPanel ([7453834](https://github.com/onlyutkarsh/mermaid-viewer/commit/7453834961fc2f69f95aed93c5d1f7c517224127))
* Normalize changelog headers and extract section for release notes ([761765a](https://github.com/onlyutkarsh/mermaid-viewer/commit/761765ad3a9008d32189bdd82fa2a2c5376189fc))
* remove token configuration from checkout step in release workflow ([c7ed7e4](https://github.com/onlyutkarsh/mermaid-viewer/commit/c7ed7e4fa9399fd07b748205882b1b02eb54b756))
* rename extension from 'Mermaid Diagram Lens' to 'Mermaid Live Preview' and update related commands and configurations ([ebc8916](https://github.com/onlyutkarsh/mermaid-viewer/commit/ebc891665e2af72e1a116775e313643694201273))
* replace PNG with WEBP format for icons showcase in README ([a12fa6a](https://github.com/onlyutkarsh/mermaid-viewer/commit/a12fa6a8fc643104982a7d895261be0f6bcd863d))
* retain zoom state ([4fc09fc](https://github.com/onlyutkarsh/mermaid-viewer/commit/4fc09fc7b25f1a4dd3e3d2f4ba8d9f102123adab))
* standardize cursor styles for panning in MermaidPreviewPanel ([10077b7](https://github.com/onlyutkarsh/mermaid-viewer/commit/10077b7f9074afee4ad115effd97c223169639f1))
* update .vscodeignore and package files for improved build process and dependencies ([e0d6e94](https://github.com/onlyutkarsh/mermaid-viewer/commit/e0d6e94e555e9ea2c7da3edb71340cc2fa0e5541))
* update cursor handling with high-dpi assets in MermaidPreviewPanel ([52ee6f0](https://github.com/onlyutkarsh/mermaid-viewer/commit/52ee6f06cb8dcd9c8b96c99277052d94eb8b0e2b)), closes [hi#dpi](https://github.com/hi/issues/dpi)
* update cursor styles and separate marketplace assets, reduce size ([b389bb8](https://github.com/onlyutkarsh/mermaid-viewer/commit/b389bb882a09466cb74f229dadcf2291355e99e0))
* update cursor styles to use 'all-scroll' for better panning experience in MermaidPreviewPanel ([aa26356](https://github.com/onlyutkarsh/mermaid-viewer/commit/aa2635627fe8674ea70589a03459a0386b0ff92f))
* update demo image links in README.md to reflect new project name ([55e3e19](https://github.com/onlyutkarsh/mermaid-viewer/commit/55e3e19ea819271dc3bf950e0c5f77a4f38edb0e))
* update demo image links to use absolute URLs in README.md ([897552a](https://github.com/onlyutkarsh/mermaid-viewer/commit/897552a1ce71ffe768309376925c569d51acc076))
* update extension name from 'Mermaid Live Preview' to 'Mermaid Viewer' in README.md, package.json, and related code ([d1627df](https://github.com/onlyutkarsh/mermaid-viewer/commit/d1627df25edbe9e25db75c0d6676a68d426e0fcb))
* update permissions and token configuration in release workflow ([a007ed5](https://github.com/onlyutkarsh/mermaid-viewer/commit/a007ed5d72c6c048fe7805f642a5bf1fb6b3afc4))
* update README and test diagram, replace icon and improve panel handling ([bb10930](https://github.com/onlyutkarsh/mermaid-viewer/commit/bb10930f03531abb8d9ab5b37a0e5f828721a44b))
* update repository URLs in README.md and package.json to reflect new project name ([428d54d](https://github.com/onlyutkarsh/mermaid-viewer/commit/428d54da7a40f274a1404b3f157e5632b6f3aa2e))


### Code Refactoring

* rename mermaidLivePreview to mermaidViewer in previewPanel.ts ([2fcf1a2](https://github.com/onlyutkarsh/mermaid-viewer/commit/2fcf1a26f0073e51f21888568f02670762cac276))


### Features

* Add fullscreen mode for mermaid diagrams in markdown preview ([c40672e](https://github.com/onlyutkarsh/mermaid-viewer/commit/c40672ed2335ed96c32d3d157257a75fd2b5da5d))
* Add functionality to copy Mermaid code without frontmatter ([d6cacc8](https://github.com/onlyutkarsh/mermaid-viewer/commit/d6cacc875fa29a6908254a12bc1a62b0fe5dc70f))
* Add functionality to copy Mermaid diagram code with customizable wrapper and improve Markdown preview isolation ([3e42ff3](https://github.com/onlyutkarsh/mermaid-viewer/commit/3e42ff3dd6a76922fae73986ea759bf5e3aa7873))
* add icon to the Mermaid preview panel ([7a200c1](https://github.com/onlyutkarsh/mermaid-viewer/commit/7a200c1b268ac996d77f35c5416522e0740800e9))
* add keyboard shortcuts functionality and display help message ([46023b0](https://github.com/onlyutkarsh/mermaid-viewer/commit/46023b01eda4603bca355926a7a0fc369dc5191c))
* add Lefthook configuration and update preview panel icon to be theme-aware ([0327c41](https://github.com/onlyutkarsh/mermaid-viewer/commit/0327c4136e55ee1911e00859a2d35b0a027bab63))
* Add memory keeper prompt and enhance preview panel with codicon support and zoom functionality ([84751d7](https://github.com/onlyutkarsh/mermaid-viewer/commit/84751d7d669e6064caaf9f823bf8571821f3c963))
* add mermaid dependency and update preview panel to use local mermaid script ([2452727](https://github.com/onlyutkarsh/mermaid-viewer/commit/24527279f9c51decac028c75ae82dcbe5b8c481e))
* add render timeout configuration for Mermaid diagrams and improve loading indicators ([96cf157](https://github.com/onlyutkarsh/mermaid-viewer/commit/96cf157e06aa44c5df63f2983aada98a820de50a))
* add support for ADO-style :::mermaid syntax and enhance rendering logic ([ca678e3](https://github.com/onlyutkarsh/mermaid-viewer/commit/ca678e3db7b8be372b1e969b2c3a9d880223f170))
* add support for ADO-style :::mermaid syntax with space and improve regex handling for windows machine ([975caf9](https://github.com/onlyutkarsh/mermaid-viewer/commit/975caf9d1657c4f4e19f6b47b30e9a32e6135186))
* Add support for Mermaid syntax highlighting and folding in .mmd files ([dd801d2](https://github.com/onlyutkarsh/mermaid-viewer/commit/dd801d2f7e3424117e50a7ce09a7ab2fc1d2e760))
* add webview panel serializer for restoring Mermaid preview panels after reload ([7736cc1](https://github.com/onlyutkarsh/mermaid-viewer/commit/7736cc17fc9dc930ea5cbf188854fe1133a4438f))
* Enhance configuration and linting setup, improve theme handling, and add type definitions ([682c180](https://github.com/onlyutkarsh/mermaid-viewer/commit/682c180935812a26e057708c2d68407ec841b418))
* enhance Mermaid diagram support with ADO-style :::mermaid syntax and update rendering logic ([fb256d6](https://github.com/onlyutkarsh/mermaid-viewer/commit/fb256d67d707f754e98a45a3f00f423a45568be3))
* enhance README and package metadata; improve preview commands and error handling ([2595cce](https://github.com/onlyutkarsh/mermaid-viewer/commit/2595cce1344419b967588092fbdb01c1e9275127))
* implement markdown-it plugin for Mermaid diagram support in markdown and enhance preview styling ([b7eac82](https://github.com/onlyutkarsh/mermaid-viewer/commit/b7eac828ec3670903044c0ae4e5f46c7b8e7d700))
* Implement suppression of appearance refresh in MermaidPreviewPanel ([03025cb](https://github.com/onlyutkarsh/mermaid-viewer/commit/03025cba57fa7d637a4c4ca90f36fb97ee1cabe6))
* improve logging and load the extension after VSCode finishes its initial startup (non-blocking) ([76cf973](https://github.com/onlyutkarsh/mermaid-viewer/commit/76cf973445b4bb52151398ebfac81d67fb9f96f6))
* Integrate ELK layout support for improved diagram rendering and add example ER diagrams ([50f71d5](https://github.com/onlyutkarsh/mermaid-viewer/commit/50f71d56116a5b024a7683c476dfd876fcf515b8))
* **preview:** add option to open Mermaid preview in a new window ([da83545](https://github.com/onlyutkarsh/mermaid-viewer/commit/da835459949693b7e3f78dc922d3e8df14540b42))
* **preview:** enhance diagram update mechanism and add webview readiness check ([c498c66](https://github.com/onlyutkarsh/mermaid-viewer/commit/c498c667c7fd1148124791a4370e818d1a62fda7))
* Update .vscodeignore to include additional configuration files ([f645412](https://github.com/onlyutkarsh/mermaid-viewer/commit/f645412edf2d07a63bc514a043bb815f091678b2))
* update icon paths and enhance Mermaid preview functionality with selection change handling ([e011f98](https://github.com/onlyutkarsh/mermaid-viewer/commit/e011f9854f405c34d5fc853968da6ad18b15230a))
* update icons showcase image for improved visual representation ([4103611](https://github.com/onlyutkarsh/mermaid-viewer/commit/4103611c4391a938ab208fa01179faa2d12277da))
* update package metadata and add repository information ([5b64fa9](https://github.com/onlyutkarsh/mermaid-viewer/commit/5b64fa9000487d75ca5c4fed6af65afef5cd6173))
* Update package.json to support UI context and markdown-it plugin registration ([5060b11](https://github.com/onlyutkarsh/mermaid-viewer/commit/5060b11b18a987e8f03d35ad8c4f8a64ac3b9cee))


### BREAKING CHANGES

* All `mermaidLivePreview.*` settings and command IDs are
renamed to `mermaidViewer.*`. Update `settings.json` keys and any custom
keybindings accordingly - the suffix after the namespace is unchanged.



