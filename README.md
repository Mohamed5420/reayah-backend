# reayah-backend

Express + TypeScript + MongoDB (Mongoose) + Socket.IO + BullMQ (Redis) + TypeDI.
Same layering as 49app: **controller → use-case / service → model**.

## Run

```bash
docker compose up -d      # MongoDB replica set + Redis + MinIO (S3)
cp .env.example .env      # set JWT_SECRET and FIELD_ENCRYPTION_KEY (generate command is in the file)
npm install
npm run dev               # tsx watch
npm run build && npm start
```

Needs MongoDB (as a replica set), Redis, and S3-compatible storage. Health check: `GET /api/v1/health`.
Bull Board: `/admin/queues` (basic auth, enabled only when `BULL_BOARD_PASSWORD` is set).

---

## Bootstrap chain

```
src/index.ts → bootstrap()
  1. import 'reflect-metadata'            (first line — TypeDI)
  2. new Server(getGlobalControllers())   (env validated on import: missing MONGO_URI / JWT_SECRET → crash early)
  3. server.initDatabase()                → connectDB() + runSeeds()
  4. PresenceCleanup.cleanStalePresence() → reset ghost "online" users
  5. server.runServer()                   → socketIOHandler() + initQueues() + listen + FCM "SERVER_BACK"
  6. setupScheduledTasks()                → BullMQ job schedulers (cron)
  7. SIGINT/SIGTERM → close sockets+http → presence cleanup → shutdownQueues() → disconnectDB()
```

`Server` constructor: `initMiddlewares() → initRoutes() → initErrorHandlers()`

```
trust proxy → helmet → cors → compression → json/urlencoded
  → RequestLogger (morgan→winston) → RateLimiter → Bull Board → Firebase init
```

All controllers are mounted under `API_PREFIX` (default `/api/v1`).

## Tree

```
src/
├── index.ts                      ← bootstrap
├── server.ts                     ← Express/HTTP class
├── api/
│   ├── controllers/
│   │   ├── index.ts              ← register controllers here
│   │   ├── interfaces/base-controller.interface.ts
│   │   ├── health/  user/
│   ├── middlewares/
│   │   ├── app/                  ← error handler, 404, rate limiter, app-status, request logger
│   │   └── auth/                 ← Auth(...roles) chain, AdminGuard
│   ├── validations/              ← zod schemas per domain (zod.ts = the configured `z`) + validate()
│   └── routers/                  ← standalone routers (uploads, webhooks, ...)
├── services/<domain>/            ← <name>.service.ts + <action>.usecase.ts + index.ts
├── database/
│   ├── connectDB.ts
│   ├── models/<domain>/<name>.model.ts
│   └── seed/
├── interfaces/                   ← I<Name>.ts
├── types/express/                ← req.user augmentation
├── gateway/                      ← Socket.IO namespaces + socket auth
├── emit/                         ← socket emitters
├── helper/                       ← socket.ts (getIO), presence-cleanup.ts
├── queues/                       ← BullMQ: names, registry, jobs/, producers/, workers/, retention, bull-board
├── config/                       ← env.config.ts (all env vars), firebase, redis, storage
├── docs/                         ← defineRoute() + OpenAPI generation, Swagger UI at /docs (dev only)
└── utils/
    ├── types-errors/             ← HttpError + typed errors (index.ts)
    ├── response/                 ← HttpResponse + pagination
    ├── i18n/                     ← t(), resolveLanguage() — catalogs in src/locales/*.json
    ├── logger/                   ← winston
    └── scheduled-tasks/          ← cron definitions
```

## Conventions

- **File names:** kebab-case everywhere. Use-cases are `<action>.usecase.ts` — one operation per file, a class with `execute()`.
- **DI:** services/use-cases are `@Service()` classes; controllers get them via `Container.get(...)`.
- **No repository layer:** services talk to Mongoose models directly.
- **Middleware chain order:**
  `CheckAppStatus → r.validate → ...Auth(UserRole.PATIENT) → handler.bind(this)`
- **Auth:** phone + OTP, no passwords. In dev the code is printed in the server log. Create admins with
  `npm run admin:create -- --phone +2010XXXXXXXX --name "Full Name"`.
- **Errors:** throw a class from `utils/types-errors`; `GlobalErrorHandlerMiddleware` renders `{ error: { code, message, fields } }`.
  Messages are translation keys — `new NotFoundError('errors.user_not_found')` — translated from `src/locales/<lang>.json` by `Accept-Language` (Arabic default).
- **Secrets:** never in the repo. Firebase credentials come from `FIREBASE_SERVICE_ACCOUNT_PATH` (`secrets/` and `*firebase-adminsdk*.json` are gitignored).

## Adding a domain (e.g. `appointment`)

1. `src/interfaces/IAppointment.ts`
2. `src/database/models/appointment/appointment.model.ts`
3. `src/services/appointment/create-appointment.usecase.ts` (+ `index.ts` barrel)
4. `src/api/validations/appointment/appointment.validation.ts` (zod request/response schemas)
5. `src/api/controllers/appointment/appointment.controller.ts` (implements `IBaseController`, declares each route with `defineRoute()`, calls `initializeRoutes()` in the constructor)
6. Add the class to `controllerClasses` in `src/api/controllers/index.ts`
7. Tests in `tests/integration/appointment.test.ts`; run `npm run openapi` to refresh `docs/openapi.json`

## Checks

```bash
npm run typecheck && npm run lint && npm run format:check && npm test   # what CI runs (plus build)
npm test -- tests/unit/i18n.test.ts                                       # a single file
```
