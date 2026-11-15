# ربط عداد الفويس بين Pella وGitHub وVercel

## 1) في Pella (البوت الرافع)
تأكد من ضبط متغيرات البوت الرافع:
- `GITHUB_TOKEN`: توكن Fine-grained يسمح Contents: Read and write على المستودع `elborgvoice` فقط.
- `GITHUB_OWNER=3zra2ele-bit`
- `GITHUB_REPO=elborgvoice`
- `GITHUB_BRANCH=main` (إذا كان هذا هو الفرع الافتراضي)
- `GITHUB_FILE_PATH=voice-stats.json`

## 2) أنشئ توكن قراءة منفصل للموقع
من GitHub أنشئ Fine-grained Personal Access Token:
- Resource owner: `3zra2ele-bit`
- Repository access: Only select repositories → `elborgvoice`
- Repository permissions → Contents: Read-only

لا تشارك التوكن أو تضفه في ملفات الموقع.

## 3) في Vercel
افتح مشروع إدارة البرج → Settings → Environment Variables وأضف:
- `VOICE_GITHUB_TOKEN` = توكن القراءة فقط الذي أنشأته في الخطوة السابقة.
- `GITHUB_OWNER` = `3zra2ele-bit`
- `GITHUB_REPO` = `elborgvoice`
- `GITHUB_BRANCH` = `main`
- `GITHUB_FILE_PATH` = `voice-stats.json`

ثم نفّذ Redeploy لآخر نسخة.

## 4) التحقق
بعد نجاح رفع البوت للملف، افتح لوحة الإدارة وسجّل الدخول بحساب مسؤول. عداد الفويس ووقت الفويس في ملفات الأعضاء سيقرآن نفس `voice-stats.json` من GitHub. الموقع لا يعرض التوكن للمتصفح.

إذا لم يظهر الملف، راجع Vercel → Functions → Logs. أخطاء 404 تعني غالبًا أن اسم الفرع أو مسار الملف غير صحيح، وأخطاء 401/403 تعني أن توكن القراءة غير صحيح أو لا يملك Contents: Read-only على المستودع.
