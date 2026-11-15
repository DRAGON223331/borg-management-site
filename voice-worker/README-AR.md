# بوت تتبع الفويس — إدارة البرج

## إعداد Pella
- **Root / Working Directory:** `voice-worker`
- **Runtime:** Node.js 20 أو أحدث
- **Install Command:** `npm install`
- **Start Command:** `npm start`
- **Port:** استخدم متغير `PORT` الذي توفره Pella أو اترك التطبيق يقرأه تلقائيًا.
- فعّل **Persistent Storage / Volume** واربطه بمسار `/app/voice-worker/data` (أو اضبط `DATA_DIR` على مسار الـ Volume الفعلي).

## Environment Variables
| الاسم | القيمة |
|---|---|
| `DISCORD_BOT_TOKEN` | توكن البوت — سري ولا يوضع في الموقع |
| `VOICE_API_KEY` | مفتاح عشوائي طويل (32 حرفًا أو أكثر) |
| `VOICE_GUILD_ID` | `1556647204255568063` افتراضيًا، أو ضع ID السيرفر الذي تريد تتبعه |
| `DATA_DIR` | `/app/voice-worker/data` إذا كان هذا هو مسار التخزين الدائم في Pella |
| `PORT` | عادةً توفره Pella تلقائيًا |

## Discord Developer Portal
فعّل **Server Members Intent** من Bot > Privileged Gateway Intents. لا يحتاج البوت Message Content أو Presence Intent.
أضف البوت للسيرفر المطلوب مع صلاحية View Channels وConnect (لا يحتاج إرسال رسائل).

## API
- `GET /health` فحص تشغيل الخدمة.
- `GET /voice-time` يحتاج Header: `Authorization: Bearer YOUR_VOICE_API_KEY`.

يرجع `/voice-time` مدة الفويس اليوم (بتوقيت القاهرة) ومدة آخر 24 و42 و72 ساعة لكل عضو.

## ملاحظات مهمة
- هذا مجلد Worker مستقل لتتبع الفويس فقط. لا تشغّل نسخة أخرى من نفس البوت Token في الوقت نفسه قبل دمج التتبع معها؛ شغّل عملية واحدة فقط لكل Token لتجنب تعدد جلسات Gateway.
- ملف `voice-stats.json` يحفظ الجلسات. يجب أن يكون `DATA_DIR` على تخزين دائم في Pella، وإلا قد يُمسح عند إعادة النشر.
- عند توقف البوت لا يتم احتساب وقت الانقطاع. عند عودته يعيد فحص الموجودين في الفويس ويبدأ جلسات جديدة.
- الموقع يحتاج Proxy/API route آمن يقرأ هذا endpoint بالمفتاح السري؛ لا تضع `VOICE_API_KEY` في JavaScript الواجهة الأمامية.
