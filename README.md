# QuickBuy 1.0

票券・限量商品・快速準備助手。**免費、手機優先、Windows 也可完整使用。**

## iPhone / iPad

GitHub Pages 直接開啟 `docs/` 內的 PWA，在 Safari 選「分享 → 加入主畫面」即可像 App 一樣使用。

QuickBuy PWA 會保存平台、數量、規格／票區與開賣時間，但 iOS PWA 無法讀取或控制另一個 Safari 分頁。登入、CAPTCHA、OTP、官方 Queue、付款與最後確認由使用者完成。

## Windows

下載 Release 的 Windows ZIP，解壓縮後雙擊 `QuickBuy-安裝精靈.cmd`。Chrome / Edge 的免費離線安裝仍需要瀏覽器的「開發人員模式 → 載入未封裝項目」；QuickBuy 不要求額外常駐程式、付費 API 或背景服務。

## 安全邊界

QuickBuy 可以做平台辨識、頁面狀態判斷、倒數、開賣提醒、數量／規格準備、前置表單、安全停止、診斷、備份與人工接力。遇到 LOGIN / CAPTCHA / OTP / QUEUE / 3D Secure / PAYMENT / FINAL CONFIRM 會交給使用者，不繞過網站安全機制，也不執行無人值守最終送單。

## 隱私

預設 local-first。同步與分享資料不包含信用卡、CVV、密碼、OTP、Cookie、Session 或登入 Token；收藏網址會移除 username、password、query 與 hash。

## 專案結構

- `docs/` — GitHub Pages / PWA
- `windows/QuickBuy-Extension/` — Chrome / Edge 擴充功能
- `windows/QuickBuy-安裝精靈.*` — Windows 安裝引導
- `tools/qa.py` — 發布前靜態 QA
- `.github/workflows/qa.yml` — GitHub Actions QA

## 隱私與安全文件

- `PRIVACY.md` — 本機儲存、網址清理與跨裝置加密說明
- `SECURITY.md` — fail-closed、安全停止與問題回報原則
