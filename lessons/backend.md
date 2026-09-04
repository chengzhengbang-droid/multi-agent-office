# 服务端、运行时与桌面端

**适用范围**：`src/server.ts`、`src/runtime/**`（Pi / Codex / deterministic 运行时、session 存储）、
`src/desktop/**` 与 `src/electron-main.ts` —— 进程、子进程生命周期、凭据、打包与更新。

## 变更日志

新的写在最上面。

（这一卷还没有条目。`git log` 里已经有几次相关的修（GPU 进程回收、Codex 取消时的
子进程竞态、hold 唤醒定时器被 GC），但当时没有留下判断，事后补写只会是猜测——
下一次改这一层时按实际踩到的坑写。）
