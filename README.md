# 足球英语小镇

根据 [PRD](/Users/linglong/项目/FootballEnglish/足球英语小镇-PRD.md) 与 `prototypes/` 原型实现的儿童英语教育 Web 应用。当前版本采用 `React + TypeScript + Vite`，重点交付原型一致的前端体验与本地优先的数据流。

## 已实现内容

- 欢迎引导页、角色选择、主地图、足球闯关、通关庆祝页
- 创意工坊：积木添加、拖拽、旋转、缩放、删除、撤销、PNG 导出
- 错题本、家长中心、家长设置、问题反馈
- API 配置页：火山引擎 / 飞书表单、连接验证、词库同步、环境检查
- `localStorage` 持久化：学习进度、错题、家长设置、作品与 API 配置

## 本地运行

```bash
npm install
npm run dev
```

默认开发地址：

```bash
http://localhost:5173
```

## 验证命令

```bash
npm run build
npm run lint
```

## 目录说明

- [src/App.tsx](/Users/linglong/项目/FootballEnglish/src/App.tsx)：主应用与页面交互
- [src/index.css](/Users/linglong/项目/FootballEnglish/src/index.css)：视觉系统与页面样式
- [src/data/gameData.ts](/Users/linglong/项目/FootballEnglish/src/data/gameData.ts)：角色、关卡、词库、工坊材料
- [src/lib/game.ts](/Users/linglong/项目/FootballEnglish/src/lib/game.ts)：闯关逻辑与格式化方法
- [src/lib/storage.ts](/Users/linglong/项目/FootballEnglish/src/lib/storage.ts)：本地存储与默认状态

## 当前实现说明

- 语音识别优先使用浏览器 `SpeechRecognition / webkitSpeechRecognition`
- 飞书词库与火山引擎验证为前端本地验证流程，未接入真实服务端签名
- 未配置真实 API 时，应用仍可使用内置示例词库完成演示
