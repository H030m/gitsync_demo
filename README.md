# 校園活動報名系統 (Campus Events)

一個用 Flutter 寫的校園活動報名 App。學生可以：

- 瀏覽校園活動清單與單一活動詳情
- 註冊 / 登入帳號
- 對活動報名或取消報名
- 查看自己已報名的活動
- 切換亮色 / 深色主題

## 技術棧

- **Flutter**（Material 3）
- **provider** — 狀態管理
- **go_router** — 路由
- 資料層目前使用 **記憶體假資料**（`lib/data/mock_store.dart`），方便 `flutter run` 直接啟動，之後可替換為 Firebase。

## 專案結構

```
lib/
  models/        活動 / 報名 / 使用者 資料模型
  data/          記憶體資料庫（種子活動 + 狀態）
  services/      認證、報名等商業邏輯（讀寫 mock store）
  theme/         亮/暗色主題
  router/        go_router 路由表
  views/         各頁面（首頁、登入、活動列表/詳情、我的報名）
```

## 開發

```bash
flutter pub get
flutter run
```

規劃文件與任務拆解見 `.trellis/tasks/`。
