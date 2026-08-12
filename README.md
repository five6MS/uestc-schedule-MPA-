# 电子科大课表

电子科技大学非全日制（如 MPA 等）课表 PWA：本地导入学校 PDF，手机/电脑查看，可离线、可添加到主屏幕。无需登录、无后端服务器。

## GitHub 仓库建议填写

创建仓库时可直接复制：

| 字段 | 建议内容 |
|------|----------|
| **Repository name** | `uestc-schedule` 或 `mpa-schedule` |
| **Description** | 电子科技大学非全日制课表 PWA：导入 PDF，周末/按周查看，离线可用，无需登录 |
| **Website**（可选） | 开启 Pages 后填：`https://你的用户名.github.io/仓库名/` |
| **Topics**（可选） | `pwa`, `schedule`, `uestc`, `pdf`, `offline` |

可见性建议选 **Public**（GitHub Pages 免费站点通常用 Public 仓库）。

## 功能

- 上传课表 PDF，浏览器本地解析（不上传服务器）
- 选择具体班级；专业名/学期/年级尽量从 PDF 标题识别（没有则不显示）
- 周末课表按周六/日展示；只列出有课条目；整周无课显示插图
- 无登录；数据仅存本机；重新导入即覆盖
- 支持分享链接 / 二维码（按**当前访问地址**自动生成）
- 可安装为 PWA，断网仍可查看已导入课表

## 在线使用（部署后）

1. 打开 GitHub Pages 地址  
2. 选择班级 → 导入 PDF  
3. 手机：添加到主屏幕后更方便离线使用  

## 本地预览

```bash
cd schedule-pwa
python -m http.server 5173
```

浏览器打开：`http://127.0.0.1:5173`

## 部署到 GitHub Pages

1. 新建空仓库（不要用 GitHub 自动生成的多余嵌套目录困扰上传）  
2. 将**本目录内文件**放到仓库根目录（根目录需有 `index.html`）  
3. 仓库 → **Settings → Pages**  
4. Source：`Deploy from a branch`  
5. Branch：`main`（或 `master`），Folder：`/ (root)` → Save  
6. 等待出现访问地址，例如：  
   `https://<username>.github.io/<repo>/`

### 用 Git 推送示例

```bash
git init
git add .
git commit -m "发布电子科大课表 PWA"
git branch -M main
git remote add origin https://github.com/<username>/<repo>.git
git push -u origin main
```

推送后按上面步骤开启 Pages。

## 分享给同学

1. 用 **Pages 公网链接**打开（不要用 `127.0.0.1`）  
2. 点击应用内「分享」→ 复制链接或保存二维码  
3. 链接与二维码会随当前网址自动变化，换域名后重新打开再分享即可  

每人各自导入 PDF，课表互不影响。

## 技术说明

- 纯静态前端 + PWA（Service Worker）  
- PDF 解析：`pdf.js`（本地）  
- 二维码：`qrcode`（打包进 `lib/qrcode-bundle.js`）  

## 注意

- 清除浏览器站点数据会导致课表丢失，需重新导入  
- 不同学院 PDF 版式差异大时，解析可能需再适配  
- `node_modules` 无需上传（已在 `.gitignore`）

## License

仅供同学学习使用；课表数据版权归学校所有。
