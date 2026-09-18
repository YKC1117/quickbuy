# QuickBuy 安全原則

QuickBuy 以 **fail-closed** 為原則。無法確定頁面狀態時，停止而不是猜測執行。

## 人工接力
下列狀態由使用者親自處理：
- LOGIN
- CAPTCHA
- OTP
- QUEUE / Waiting Room
- 3D Secure
- PAYMENT
- FINAL CONFIRM

QuickBuy 不提供 CAPTCHA 破解、Cloudflare / Queue 繞過、OTP 攔截、登入繞過、browser fingerprint bypass、多帳號 flooding、自動付款或無人值守最終送單。

## 問題回報
請透過 GitHub Issues 回報，並避免貼出帳密、Cookie、Token、信用卡或其他敏感資訊。
