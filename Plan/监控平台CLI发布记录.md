# 监控平台 CLI 发布记录

版本：0.1.0。日期：2026-10-13。包名：`@cxdlogver/browser-monitor-cli`。全局指令：`bm`。目标注册表：`https://registry.npmjs.org/`，公开访问，`latest` 标签。

## 发布目标与当前状态

本次将仓库内 CLI 转为独立 npm 包，使人和 AI 可以在任意业务目录全局调用 `bm`，无需下载源码、安装 TypeScript 或先执行构建。平台服务、账号、项目权限及诊断接口要求仍按原有契约执行。

当前状态：**公开发布完成**。[npm 包页面](https://www.npmjs.com/package/@cxdlogver/browser-monitor-cli)可供安装，`latest` 指向 0.1.0。打包、回归、Windows 与 Linux 全局入口验证通过，注册表匿名下载完整性与已测试 tarball 一致，本机已从 npm 注册表重新全局安装并在官网业务目录直接运行 `bm --help` 成功。

## 包配置与交付物

CLI 包移除 `private`，增加公开 npm 注册表配置、MIT 许可证、作者、仓库与问题反馈地址、变更说明和文件白名单。运行时依赖仅为 Node.js 内置模块，要求 Node.js 22 或以上。

打包文件包括 `package.json`、`README.md`、`CHANGELOG.md`、`LICENSE`、`bin/bm.mjs` 以及 9 个 `dist/*.js` 模块。TypeScript 源文件、测试脚本、验收证据、业务 JSON、用户会话和工作区依赖不在发布包中。`bin/bm.mjs` 使用 Node shebang，npm 为全局安装生成平台对应的入口。

`prepack` 构建运行文件；从包目录发布时 `prepublishOnly` 运行类型检查、回归和独立安装验证。本次实际发布使用已经验证且固定完整性的 tarball，不在认证后临时重新打包。

本批次安装包：[cxdlogver-browser-monitor-cli-0.1.0.tgz](发布记录/2026-10-13T15-01-43.293Z-ef2a4fe6/cxdlogver-browser-monitor-cli-0.1.0.tgz)。压缩大小 23467 字节，解压总量 69492 字节，共 14 个文件。

完整性为：

~~~text
sha512-IMSSHjoBr2FWJQXWVQqqTgmNJYrirqofbtK9LWgGHkfdpiCTBFa/vhXM31EcPZfc5zeH5QVUKsMmalOpEj6pHg==
~~~

SHA-1 为 `df8aa3bc05f45136574f7b3940ad530bedb4d17f`。文件清单见[pack-manifest.json](发布记录/2026-10-13T15-01-43.293Z-ef2a4fe6/pack-manifest.json)，安装与夹具检查的调用、退出码、stdout 和判定见[package-verification.json](发布记录/2026-10-13T15-01-43.293Z-ef2a4fe6/package-verification.json)。

## 验证步骤与观察

先执行 `npm run check`，类型检查通过，CLI 27 条回归全部通过。再执行 `npm run test:package`，构建并打包后检查文件白名单、包名和版本、全部运行模块及 tarball 完整性。

验证脚本把 tarball 安装到独立全局前缀，业务工作目录与源码目录分离。通过实际全局指令入口运行 `--help`，再使用明确标注的本地接口夹具检查健康 JSON、Session 保存、默认项目选择、相对路径 SDK JSON 与 TypeScript 示例，以及输入错误的规范 JSON 和退出码。安装文件内容与打包源文件逐字节一致，无运行时第三方依赖。所有 10 项验证断言通过，独立安装及夹具产物保留在本批次目录。

Linux 检查在本地镜像 `browser-monitor-cli-dev-check:20261013` 中离线运行，没有网络访问，容器完成后自动移除。Node.js 22.23.3 下从相同 tarball 全局安装成功，`bm --help`、可执行权限及 `INVALID_ARGUMENT` 退出码 2 检查通过。证据见[linux-verification.json](发布记录/2026-10-13T15-01-43.293Z-ef2a4fe6/linux-verification.json)。

本机还实际执行了本地 tarball 全局安装，安装位置为 `D:/xiang/CX_repo/nodejs/node_global`。`where bm` 返回全局 `bm` 与 `bm.cmd`，直接运行 `bm --help` 成功，`npm ls --global @cxdlogver/browser-monitor-cli --json` 确认版本为 0.1.0。该观察来自本地 tarball，不冒充注册表下载安装。

## 发布过程与认证

npm 登录账号为 `cxdlogver`，发布前该包名查询返回 E404。发布预演成功，预演的文件、版本和完整性与已验证 tarball 一致。

第一次公开发布被自动审批拒绝，要求补充具体包和内容的公开授权；用户随后明确确认将该版本公开到 npm。之后非交互发布被 npm 账号双因素认证拒绝，错误为 EOTP。按用户指定切换到 `--auth-type=web` 与交互终端，通过 npm 官方浏览器设备认证继续。认证令牌、一次性验证码和会话链接不写入项目或发布证据。

设备认证完成后，npm 发布命令退出码为 0，返回 `+ @cxdlogver/browser-monitor-cli@0.1.0`。注册表版本、`latest` 和访问状态回查确认 0.1.0、`latest=0.1.0`、`public`。

在不发送登录凭据的独立 HTTPS 请求中，包元数据和 tarball 均返回 200；下载 23467 字节，SHA-512 与预验收和注册表声明的完整性完全一致。证据见[registry-verification.json](发布记录/2026-10-13T15-01-43.293Z-ef2a4fe6/registry-verification.json)。

本机随后使用全新缓存从 npm 官方注册表安装包名与精确版本，元数据和 tarball 均为 HTTP 200/cache miss，安装退出码 0；在官网业务目录直接运行 `bm --help` 退出码 0。安装观察见[global-registry-installation.json](发布记录/2026-10-13T15-01-43.293Z-ef2a4fe6/global-registry-installation.json)。发布完成状态见[publication-status.json](发布记录/2026-10-13T15-01-43.293Z-ef2a4fe6/publication-status.json)。

## 安装方式与发布 checklist

直接从注册表全局安装：

~~~sh
npm install --global @cxdlogver/browser-monitor-cli@0.1.0
bm --help
bm health --base-url http://localhost:8080
~~~

本地安装包现在即可使用：

~~~powershell
npm install --global F:/CX_notes/cx-learn-notes/browser-monitor/Plan/发布记录/2026-10-13T15-01-43.293Z-ef2a4fe6/cxdlogver-browser-monitor-cli-0.1.0.tgz
bm --help
~~~

如果终端仍保留此前定义的 `function bm`，它可能优先于全局指令，应移除该函数或使用新终端。Windows PowerShell 的脚本限制可通过显式 `bm.cmd` 调用 npm 生成的命令入口。

- [x] 包元数据、许可证、变更说明和文件白名单完成。
- [x] 类型检查与 27 条 CLI 回归通过。
- [x] 实际 tarball 的独立全局安装和 10 项断言通过。
- [x] Windows 本机全局安装与直接调用通过。
- [x] 离线 Linux 全局入口与错误输出通过。
- [x] 发布预演及具体包公开授权完成。
- [x] npm 设备认证及公开发布成功。
- [x] 注册表版本、标签及完整性独立回查。
- [x] 注册表来源的全局安装和 `bm` 指令验证。

逐命令说明和两个真实业务的输入、输出见[CLI 指令使用说明](监控平台CLI指令使用说明.md)。此记录只补充打包、安装和发布验证，不修改既有的 47 项业务输入与功能验收证据。
