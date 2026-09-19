# QuickBuy 隱私說明

QuickBuy 1.0 採 **local-first** 設計。一般設定優先保存在使用者自己的瀏覽器。

## 不同步的資料
QuickBuy 不會把以下資料放進跨裝置同步封包：
- 信用卡號、CVV / CVC
- 密碼
- OTP / 驗證碼
- Cookie
- Session
- 登入 Token / Access Token
- 付款憑證

## 網址清理
收藏、接力與提醒使用的網址會移除 username、password、敏感 query（例如 token、session、OTP、API key）與追蹤參數；一般商品／活動所需的功能 query 會保留，避免清理後失去原商品或原活動頁。若 hash 內含敏感憑證也會移除。

## 加密接力
加密接力使用 PBKDF2-SHA256 衍生金鑰與 AES-256-GCM。密語由使用者自己保管，不寫入同步封包。

## iPhone / iPad
PWA 無法直接控制另一個 Safari 分頁。QuickBuy 只保存準備設定並提供快速入口，不攔截 Safari 登入資料或付款資訊。
