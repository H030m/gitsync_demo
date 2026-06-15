# 課程教學方法總覽 (Course Methods Reference)

> **這份文件的用途**：給隊友的 AI assistant 在寫 GitSync 程式碼時參考。**所有寫法請優先採用本文件列出的課程作法**；若課程沒教某項技術，再選相容的最佳實踐。所有範例摘自 `D:\my_dir\NTHU\Software Studio\old\software_design\` 下的考古題程式碼。
>
> **技術棧已固定**：Flutter (iOS + Android) + Firebase (Functions / Firestore / Auth / Storage / Messaging) + OpenAI 官方 SDK（直接用，不走 Genkit）。
>
> **AI 部分的取捨**：課程的 AI Agent 章節示範的是 Genkit。我們改用 OpenAI 原生 SDK（function calling、structured outputs、native embeddings），不勉強套 Genkit。**但仍保留課程教的「flow + prompts 分檔」組織方式**——只是把 Genkit 的 `definePrompt/defineFlow` 換成手寫的 prompt 模板字串 + async function。

---

## 0. 專案目錄結構（MVVM 分層，必須遵守）

依 [`lab-flutter-basics-dart-group-todo-list-example`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-group-todo-list-example/lib/) 的 layout：

```
lib/
├── main.dart                    # MultiProvider + MaterialApp.router 入口
├── firebase_options.dart        # flutterfire configure 自動生成
├── models/                      # 純資料類，含 fromMap/toMap
│   ├── user.dart
│   ├── repo.dart
│   └── task.dart
├── repositories/                # Firestore CRUD，回傳 Stream/Future
│   ├── user_repo.dart
│   ├── repo_repo.dart
│   └── task_repo.dart
├── services/                    # 跨切面服務（Auth、Navigation、Push、API client）
│   ├── authentication.dart
│   ├── navigation.dart
│   ├── push_messaging.dart
│   └── ai_service.dart
├── view_models/                 # ChangeNotifier，每個畫面一個
│   ├── repo_list_vm.dart
│   ├── task_board_vm.dart
│   └── ...
├── views/                       # 整頁 Widget（StatefulWidget），對應 routes
│   ├── sign_in_page.dart
│   ├── repo_list_page.dart
│   └── tasks/
├── widgets/                     # 可重用元件（TaskCard、BottomNav 等）
├── state/                       # 純客戶端全域狀態（不需後端時用，例：FavoriteNotifier）
├── data/                        # 靜態 dummy data / categories enum
└── utils/                       # 純函式工具
```

**規則**：
- View 只能 `Provider.of<ViewModel>` 或 `Consumer<ViewModel>`，**不可直接 import Repository**
- ViewModel 不可 import Widget / BuildContext（除了在 callback 透過參數傳入）
- Repository 是唯一摸 Firestore 的層；其他層都用 model object

---

## 1. State Management — `provider` 套件

**唯一使用的狀態管理套件**：`provider: ^6.1.2`（不要用 Riverpod、Bloc、GetX）。

### 1.1 MultiProvider 在 main.dart 註冊

來源：[`meals-app-animation/lib/main.dart`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-meals-app-animation/lib/main.dart)

```dart
void main() {
  runApp(
    MultiProvider(
      providers: [
        Provider<NavigationService>(create: (_) => NavigationService()),
        Provider<List<Meal>>(create: (_) => dummyMeals),
        ChangeNotifierProvider<FavoriteMealsNotifier>(
            create: (_) => FavoriteMealsNotifier()),
        // 依賴其他 Provider 的 ChangeNotifier，用 ProxyProvider
        ChangeNotifierProxyProvider2<List<Meal>, FiltersNotifier,
            FilteredMealsNotifier>(
          create: (_) => FilteredMealsNotifier(),
          update: (_, allMeals, filtersNotifier, prev) =>
              prev!..updateFilteredMeals(allMeals, filtersNotifier.filters),
        ),
      ],
      child: const App(),
    ),
  );
}
```

### 1.2 ChangeNotifier ViewModel

來源：[`group-todo-list-example/lib/view_models/todos_of_user_vm.dart`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-group-todo-list-example/lib/view_models/todos_of_user_vm.dart)

```dart
class TodosOfUserViewModel with ChangeNotifier {
  final TodoItemRepository _todoItemRepository;
  StreamSubscription<List<TodoItem>>? _itemsSubscription;

  List<TodoItem> _todoItems = [];
  List<TodoItem> get todoItems => _todoItems;

  TodosOfUserViewModel({TodoItemRepository? todoItemRepository})
      : _todoItemRepository = todoItemRepository ?? TodoItemRepository() {
    _itemsSubscription = _todoItemRepository.streamTodoItems(userId).listen((items) {
      _todoItems = items;
      notifyListeners();        // ← 通知 UI 重繪
    });
  }

  @override
  void dispose() {
    _itemsSubscription?.cancel(); // ← 一定要 cancel 訂閱
    super.dispose();
  }

  // 給 ChangeNotifierProxyProvider 用：當依賴的 state 變了，從外面餵新值進來
  void updateViewModel(List<User> allUsers) {
    _otherUsers = allUsers.where((u) => u.id != userId).toList();
    notifyListeners();
  }
}
```

### 1.3 View 端取用

```dart
// 重繪：用 Consumer
return Consumer<TodosOfUserViewModel>(
  builder: (context, vm, child) => ListView(...),
);

// 一次性讀取（不重繪）：用 Provider.of(..., listen: false)
final nav = Provider.of<NavigationService>(context, listen: false);
final vm = Provider.of<TodosOfUserViewModel>(context, listen: false);
```

---

## 2. Navigation — `go_router`

**唯一使用的 router 套件**：`go_router: ^14.0.2`。把 router 包進 `NavigationService` service，View 不直接呼叫 `GoRouter.of(context)`。

來源：[`group-todo-list-example/lib/services/navigation.dart`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-group-todo-list-example/lib/services/navigation.dart)

### 2.1 routerConfig 結構

```dart
final routerConfig = GoRouter(
  initialLocation: '/users',
  debugLogDiagnostics: true,
  routes: <RouteBase>[
    // ShellRoute 用來在子路由共用 Provider（不會重建）
    ShellRoute(
      builder: (ctx, state, child) => ChangeNotifierProvider(
        create: (_) => AllUsersViewModel(),
        child: child,
      ),
      routes: <RouteBase>[
        GoRoute(
          path: '/users',
          pageBuilder: (ctx, state) =>
              const NoTransitionPage<void>(child: UserGridPage()),
          routes: <RouteBase>[
            GoRoute(path: 'add', builder: (_, __) => const AddUserPage()),
            ShellRoute(
              builder: (ctx, state, child) =>
                  ChangeNotifierProxyProvider<AllUsersViewModel, TodosOfUserViewModel>(
                create: (_) => TodosOfUserViewModel(
                  userId: state.pathParameters['userId']!,
                ),
                update: (_, allUsersVm, prev) =>
                    prev!..updateViewModel(allUsersVm.users),
                child: child,
              ),
              routes: [
                GoRoute(
                  path: ':userId/todos',
                  builder: (_, s) => TodoListPage(userId: s.pathParameters['userId']!),
                ),
              ],
            ),
          ],
        ),
      ],
    ),
  ],
  redirect: (ctx, state) => state.uri.path == '/' ? '/users' : null,
  errorBuilder: (_, state) => Scaffold(body: Center(child: Text('Not found: ${state.uri.path}'))),
);
```

### 2.2 NavigationService 包一層

```dart
class NavigationService {
  late final GoRouter _router;
  NavigationService() { _router = routerConfig; }

  void goRepos() => _router.go('/repos');
  void goTasks(String repoId) => _router.go('/repos/$repoId/tasks');
  void pop(BuildContext ctx) => _router.pop(ctx);
}
```

View 端：`Provider.of<NavigationService>(context, listen: false).goTasks(repoId);`

---

## 3. Firebase 整合

### 3.1 安裝套件（pubspec.yaml）

照 [`group-chat-app-2.0/pubspec.yaml`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-group-chat-app-2.0/pubspec.yaml)：

```yaml
dependencies:
  provider: ^6.1.2
  go_router: ^14.0.2
  firebase_core: ^2.26.0
  firebase_auth: ^4.4.0
  cloud_firestore: ^4.15.7
  firebase_storage: ^11.1.0
  firebase_messaging: ^14.9.2
  cloud_functions: ^4.7.5
  google_sign_in: ^6.2.1
  google_fonts: ^6.x
  flutter_native_splash: ^2.3.10
  image_picker: ^1.1.1
  flutter_svg: ^2.0.10+1
  universal_html: ^2.2.4
```

### 3.2 初始化（main.dart）

來源：[`group-chat-app-2.0/lib/main.dart`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-group-chat-app-2.0/lib/main.dart)

```dart
void main() async {
  WidgetsBinding widgetsBinding = WidgetsFlutterBinding.ensureInitialized();
  FlutterNativeSplash.preserve(widgetsBinding: widgetsBinding);  // 延後第一幀

  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);

  runApp(StreamBuilder<bool>(
    stream: AuthenticationService().authStateChanges(),
    builder: (ctx, snapshot) {
      if (snapshot.connectionState != ConnectionState.active) return const SizedBox.shrink();
      if (snapshot.hasError) debugPrint('Auth Error: ${snapshot.error}');
      FlutterNativeSplash.remove();
      // 用 key 強制 rebuild 整顆 app（讓 router 重新跑 redirect）
      return MyApp(key: ValueKey(snapshot.data));
    },
  ));
}
```

---

## 4. Model + Repository 寫法

### 4.1 Model — null-safe + Firestore Timestamp

來源：[`group-todo-list-example/lib/models/todo_item.dart`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-group-todo-list-example/lib/models/todo_item.dart)

```dart
class TodoItem {
  String? id;                       // 由 Firestore 生成，本地 cache 階段就有
  final String name;
  final String? details;
  final Category category;
  final String userId;
  Timestamp? _createdDate;
  Timestamp get createdDate => _createdDate ?? Timestamp.now(); // server-side 才有值，給 fallback
  final bool isDone;

  // 給 View / ViewModel 用的公開建構式
  TodoItem({
    required this.name,
    this.details,
    required this.category,
    required this.userId,
    this.isDone = false,
  });

  // 給 Repository 用的私有建構式（含 id、createdDate）
  TodoItem._({
    required this.id,
    required this.name,
    this.details,
    required this.category,
    required this.userId,
    required Timestamp? createdDate,
    this.isDone = false,
  }) : _createdDate = createdDate;

  factory TodoItem.fromMap(Map<String, dynamic> map, String id) {
    return TodoItem._(
      id: id,
      name: map['name'],
      details: map['details'],
      category: categories.entries
          .firstWhere((c) => c.value.title == map['category']).value,
      userId: map['userId'],
      createdDate: map['createdDate'],
      isDone: map['isDone'],
    );
  }

  Map<String, dynamic> toMap() => {
    'id': id,
    'name': name,
    'details': details,
    'category': category.title,
    'userId': userId,
    'createdDate': _createdDate,
    'isDone': isDone,
  };

  @override
  bool operator ==(Object o) =>
      identical(this, o) ||
      o is TodoItem && runtimeType == o.runtimeType && id == o.id;
  @override
  int get hashCode => id.hashCode;
}
```

### 4.2 Repository — Stream / Future + transaction

來源：[`group-todo-list-example/lib/repositories/todo_item_repo.dart`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-group-todo-list-example/lib/repositories/todo_item_repo.dart)

```dart
class TodoItemRepository {
  final FirebaseFirestore _db = FirebaseFirestore.instance;
  final timeout = const Duration(seconds: 10);

  Stream<List<TodoItem>> streamTodoItems(String userId) {
    return _db.collection('apps/group-todo-list/users')
        .doc(userId).collection('todo-items')
        .orderBy('createdDate', descending: true)
        .snapshots()
        .map((snap) => snap.docs.map((d) =>
            TodoItem.fromMap(d.data() as Map<String, dynamic>, d.id)).toList());
  }

  Future<String> addItem(String userId, TodoItem item) async {
    final map = item.toMap()..remove('id');
    map['createdDate'] = FieldValue.serverTimestamp();  // ← 由 server 寫入時間
    final docRef = await _db.collection('apps/group-todo-list/users')
        .doc(userId).collection('todo-items')
        .add(map).timeout(timeout);
    return docRef.id;
  }

  Future<void> toggleDone(String userId, String itemId) async {
    final ref = _db.collection('apps/group-todo-list/users')
        .doc(userId).collection('todo-items').doc(itemId);
    return _db.runTransaction((tx) async {            // ← 跨欄位用 transaction
      final snap = await tx.get(ref);
      if (!snap.exists) throw Exception('Not found');
      tx.update(ref, {'isDone': !(snap.data()?['isDone'] ?? false)});
    });
  }
}
```

**Firestore 路徑命名規範**：所有 collection 都掛在 `apps/<app-name>/...` 之下，例：
- `apps/gitsync/users/{userId}`
- `apps/gitsync/repos/{repoId}`
- `apps/gitsync/repos/{repoId}/tasks/{taskId}`
- `apps/gitsync/repos/{repoId}/commits/{commitSha}`

---

## 5. Authentication

來源：[`group-chat-app-2.0/lib/services/authentication.dart`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-group-chat-app-2.0/lib/services/authentication.dart)

### 核心要點

```dart
class AuthenticationService {
  final FirebaseAuth _firebaseAuth = FirebaseAuth.instance;

  // 1. 登入狀態流（用在 main.dart 的 StreamBuilder）
  Stream<bool> authStateChanges() =>
      _firebaseAuth.idTokenChanges().map((user) => user != null);

  // 2. Google sign-in（OAuth）
  Future<String?> logInWithGoogle(BuildContext ctx) async {
    final googleUser = await GoogleSignIn().signIn();
    if (googleUser == null) return null;
    final auth = await googleUser.authentication;
    final cred = GoogleAuthProvider.credential(
      accessToken: auth.accessToken,
      idToken: auth.idToken,
    );
    final user = (await _firebaseAuth.signInWithCredential(cred)).user!;
    return user.uid;
  }

  // 3. 取 custom claims（自訂角色）
  Future<void> _postLogIn(User user) async {
    final idTokenResult = await user.getIdTokenResult(true);
    final isModerator = idTokenResult.claims?['isModerator'] ?? false;
  }

  String? checkAndGetLoggedInUserId() {
    final user = _firebaseAuth.currentUser;
    if (user == null) return null;
    user.reload();
    return _firebaseAuth.currentUser?.uid;
  }
}
```

**GitSync 用法**：因為要拿 GitHub repo，登入流程是「Firebase Auth 用 GitHub OAuth provider 登入」，同時把 GitHub access token 拿下來存到使用者文件。`firebase_auth` 原生支援 `GithubAuthProvider`。

---

## 6. Cloud Functions（後端）

來源：
- [`group-todo-list-example/functions/index.js`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-group-todo-list-example/functions/index.js)
- [`group-chat-app-2.0/functions/index.js`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-group-chat-app-2.0/functions/index.js)

### 6.1 三類 trigger

```js
const { logger, https } = require("firebase-functions/v2");
const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } =
  require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

// (1) Callable — 從 Flutter 直接呼叫
exports.subscribeToTopic = https.onCall(async (request) => {
  const { token, topic } = request.data;
  const uid = request.auth.uid;
  if (!uid) throw new https.HttpsError("failed-precondition", "Log in first.");
  await admin.messaging().subscribeToTopic(token, topic);
  return { message: `Subscribed to ${topic}` };
});

// (2) Firestore trigger — 對寫入事件反應
exports.onTaskCreated = onDocumentCreated(
  { document: "apps/gitsync/repos/{repoId}/tasks/{taskId}", region: "asia-east1" },
  async (event) => { /* ... */ }
);

// (3) HTTP request — 外部 webhook 用（GitHub / Discord）
const { onRequest } = require("firebase-functions/v2/https");
exports.githubWebhook = onRequest(async (req, res) => { /* ... */ });
```

### 6.2 **必學：Idempotency Key 模式**

> 課程明確要求所有 Firestore trigger 都要做 idempotency check（trigger 可能會被重送）

```js
exports.onTaskCreated = onDocumentCreated(
  { document: "apps/gitsync/repos/{repoId}/tasks/{taskId}", region: "asia-east1" },
  async (event) => {
    const idempotencyRef = db.doc(`apps/gitsync/idempotencyKeys/${event.id}`);

    try {
      await db.runTransaction(async (tx) => {
        const idDoc = await tx.get(idempotencyRef);
        if (idDoc.exists) {
          logger.info("Already processed, skipping");
          return;
        }

        // ... 實際業務邏輯 ...

        tx.set(idempotencyRef, { processedAt: FieldValue.serverTimestamp() });
      });
    } catch (e) { logger.error("Error", e); }
  }
);
```

### 6.3 Region 一律 `asia-east1`

> 課程範例用 `us-west1`，本專案改成 `asia-east1` 因為團隊與 demo 在台灣、Firestore 也建在 `asia-east1`，跨區 trigger latency 從 ~150ms 降到 ~10ms。見 [MEMORY.md 2026-05-27](./MEMORY.md#2026-05-27--cloud-functions-region-改成-asia-east1取代-us-west1)。

---

## 7. Push Notification (FCM)

來源：[`group-chat-app-2.0/lib/services/push_messaging.dart`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-group-chat-app-2.0/lib/services/push_messaging.dart)

```dart
class PushMessagingService {
  final FirebaseMessaging _firebaseMessaging = FirebaseMessaging.instance;
  final subscribedTopics = <String>{};

  Future<bool> initialize({required String userId, required List<String> topics}) async {
    final settings = await _firebaseMessaging.requestPermission();
    if (settings.authorizationStatus != AuthorizationStatus.authorized) return false;

    // 前景 / 開啟通知 / 背景三個 handler
    FirebaseMessaging.onMessage.listen((m) { /* foreground */ });
    FirebaseMessaging.onMessageOpenedApp.listen((m) { /* tap 通知 */ });
    FirebaseMessaging.onBackgroundMessage(_backgroundMessageHandler);

    final token = await _firebaseMessaging.getToken();
    if (token != null) await _userRepository.updateUserFcmToken(userId, token);

    _firebaseMessaging.onTokenRefresh.listen((t) =>
        _userRepository.updateUserFcmToken(userId, t));

    return true;
  }
}

@pragma('vm:entry-point')              // ← 不要被 tree-shake 掉
Future<void> _backgroundMessageHandler(RemoteMessage message) async {}
```

---

## 8. AI Agent — OpenAI SDK 直接使用（後端）

> 課程示範用 Genkit，但 GitSync 採用 OpenAI 官方 SDK 直接呼叫。**仍保留課程教的「flow + prompts 分檔」組織方式**——好處是換 model / 加 step / 寫測試都容易。

參考課程 Genkit 範例的「分層方式」（不是 API）：[`genkit-recipe-app-example/functions/src/`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-genkit-recipe-app-example/functions/src/)

### 8.1 安裝

```bash
cd functions
npm install openai zod
```

### 8.2 目錄結構

```
functions/
├── src/
│   ├── index.ts            # export 所有 Cloud Functions
│   ├── config.ts           # OpenAI client 單例 + 預設 model
│   ├── types.ts            # zod schemas（input/output）
│   ├── prompts/
│   │   ├── breakdownTask.ts    # export const breakdownTaskSystem = `...`
│   │   ├── assignTask.ts
│   │   └── generateHandoff.ts
│   ├── flows/
│   │   ├── breakdownTask.ts    # 主流程：多 step + tool use
│   │   ├── assignTask.ts
│   │   ├── generateHandoff.ts
│   │   └── summarizeDay.ts
│   ├── tools/                  # 給 OpenAI function calling 用
│   │   ├── github.ts           # listCommits / getDiff
│   │   ├── firestore.ts        # readTasks / readDiscordMessages
│   │   └── embedding.ts        # vector search 包裝
│   └── handlers/               # Callable / HTTP / Trigger entrypoint
│       ├── breakdownTaskHandler.ts
│       └── githubWebhookHandler.ts
```

**規則**：
- `prompts/` 只放純字串模板（用 template literal 或 simple `${}` 插值，**不用 Handlebars**）
- `flows/` 是主邏輯，每個 flow 是一個 async function
- `tools/` 是給 OpenAI function calling 註冊的純函式 + JSON schema

### 8.3 OpenAI client 設定（`config.ts`）

```ts
import OpenAI from 'openai';
import { defineSecret } from 'firebase-functions/params';

export const openaiKey = defineSecret('OPENAI_API_KEY');

export function getOpenAI(): OpenAI {
  return new OpenAI({ apiKey: openaiKey.value() });
}

export const MODELS = {
  reasoning: 'gpt-4o',           // 拆解、分派、審查
  fast: 'gpt-4o-mini',           // commit summary、輕量分類
  embedding: 'text-embedding-3-small',  // 1536 dim
} as const;
```

### 8.4 Prompt 檔（純字串）

```ts
// prompts/breakdownTask.ts
export const breakdownTaskSystem = `You are a senior software engineer helping a team break down a project goal into actionable subtasks.

Rules:
- Decide subtask count based on complexity (typically 3-8).
- Set dependencies via 0-based index references in dependsOn[].
- Avoid circular dependencies.
- Each subtask should be completable in 1-3 hours by one engineer.
- Use the team's existing tech stack from the project context.`;

export function breakdownTaskUser(input: { projectContext: string; goal: string }): string {
  return `Project context:
${input.projectContext}

Goal to break down:
${input.goal}

Return JSON matching the schema.`;
}
```

### 8.5 Zod schema + Structured Outputs（`types.ts`）

```ts
import { z } from 'zod';

export const SubtaskSchema = z.object({
  title: z.string().describe('Short imperative title'),
  description: z.string(),
  dependsOn: z.array(z.number().int()).describe('0-based indices of prerequisite subtasks'),
  estimatedHours: z.number(),
});

export const BreakdownOutputSchema = z.object({
  subtasks: z.array(SubtaskSchema),
});

export type BreakdownOutput = z.infer<typeof BreakdownOutputSchema>;
```

### 8.6 Flow 寫法（多 step + structured output + 自我驗證）

```ts
// flows/breakdownTask.ts
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import { getOpenAI, MODELS } from '../config';
import { breakdownTaskSystem, breakdownTaskUser } from '../prompts/breakdownTask';
import { BreakdownOutputSchema, BreakdownOutput } from '../types';
import { fetchProjectContext } from '../tools/firestore';
import { logger } from 'firebase-functions/v2';

export async function breakdownTaskFlow(input: { repoId: string; goal: string }): Promise<BreakdownOutput> {
  const openai = getOpenAI();

  // Step 1: 讀取專案上下文（Firestore + GitHub recent commits + README）
  logger.info('Step 1: fetch project context');
  const projectContext = await fetchProjectContext(input.repoId);

  // Step 2: 第一次拆解 — 用 OpenAI structured outputs，保證 JSON 格式正確
  logger.info('Step 2: initial breakdown');
  const completion = await openai.chat.completions.parse({
    model: MODELS.reasoning,
    messages: [
      { role: 'system', content: breakdownTaskSystem },
      { role: 'user', content: breakdownTaskUser({ projectContext, goal: input.goal }) },
    ],
    response_format: zodResponseFormat(BreakdownOutputSchema, 'subtasks'),
  });
  let result = completion.choices[0].message.parsed!;

  // Step 3: agentic 自我驗證（純 TS 檢查循環依賴）
  logger.info('Step 3: verify dependencies');
  const cycles = detectCycles(result.subtasks);
  if (cycles.length > 0) {
    // Step 3b: 自我修正 — 再餵一次 prompt 告知 cycle，要求修正
    logger.info(`Found ${cycles.length} cycle(s), asking LLM to fix`);
    const fixCompletion = await openai.chat.completions.parse({
      model: MODELS.reasoning,
      messages: [
        { role: 'system', content: breakdownTaskSystem },
        { role: 'user', content: breakdownTaskUser({ projectContext, goal: input.goal }) },
        { role: 'assistant', content: JSON.stringify(result) },
        { role: 'user', content: `Detected circular dependencies: ${JSON.stringify(cycles)}. Please fix dependsOn to remove cycles.` },
      ],
      response_format: zodResponseFormat(BreakdownOutputSchema, 'subtasks'),
    });
    result = fixCompletion.choices[0].message.parsed!;
  }

  return result;
}

function detectCycles(subtasks: Array<{ dependsOn: number[] }>): number[][] {
  // 標準 DFS cycle detection
  // ... (純 TS 實作)
}
```

### 8.7 Function Calling（給 agent 自主檢索的能力）

當 flow 需要 agent **自己決定**該拉什麼資料時（核心功能 02 任務分派、核心功能 03 交接文件），用 OpenAI 的 tool use：

```ts
// flows/generateHandoff.ts
import { getOpenAI, MODELS } from '../config';
import { listRelatedCommitsTool, getCommitDiffTool, searchDiscordMessagesTool } from '../tools';

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'listRelatedCommits',
      description: 'List commits linked to a specific task',
      parameters: {
        type: 'object',
        properties: {
          repoId: { type: 'string' },
          taskId: { type: 'string' },
        },
        required: ['repoId', 'taskId'],
      },
    },
  },
  // ... 其他 tool definitions
];

export async function generateHandoffFlow(input: { repoId: string; completedTaskId: string }) {
  const openai = getOpenAI();
  const messages: any[] = [
    { role: 'system', content: handoffSystem },
    { role: 'user', content: `Generate a handoff for completed task ${input.completedTaskId} in repo ${input.repoId}.` },
  ];

  // Agentic loop — 最多跑 5 round
  for (let round = 0; round < 5; round++) {
    const response = await openai.chat.completions.create({
      model: MODELS.reasoning,
      messages,
      tools,
      tool_choice: 'auto',
    });

    const msg = response.choices[0].message;
    messages.push(msg);

    // Agent 不再叫 tool → 結束
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { handoffMarkdown: msg.content! };
    }

    // 執行 agent 要求的 tools（可平行）
    const toolResults = await Promise.all(msg.tool_calls.map(async (tc) => {
      const args = JSON.parse(tc.function.arguments);
      let result: any;
      switch (tc.function.name) {
        case 'listRelatedCommits': result = await listRelatedCommitsTool(args); break;
        case 'getCommitDiff':      result = await getCommitDiffTool(args); break;
        case 'searchDiscordMessages': result = await searchDiscordMessagesTool(args); break;
      }
      return { tool_call_id: tc.id, role: 'tool' as const, content: JSON.stringify(result) };
    }));

    messages.push(...toolResults);
  }

  throw new Error('Handoff generation exceeded max rounds');
}
```

### 8.8 對外暴露 — 標準 Callable

```ts
// index.ts (與 group-todo-list 範例的 onCall 寫法一致)
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { openaiKey } from './config';
import { breakdownTaskFlow } from './flows/breakdownTask';

export const breakdownTask = onCall(
  { region: 'asia-east1', secrets: [openaiKey] },
  async (request) => {
    if (!request.auth) throw new HttpsError('failed-precondition', 'Please log in first.');
    const { repoId, goal } = request.data;
    return await breakdownTaskFlow({ repoId, goal });
  }
);
```

### 8.9 Flutter 呼叫端（不變）

```dart
import 'package:cloud_functions/cloud_functions.dart';

Future<List<Subtask>> breakdownTask(String repoId, String goal) async {
  final callable = FirebaseFunctions.instanceFor(region: 'asia-east1')
      .httpsCallable('breakdownTask');
  final response = await callable.call({'repoId': repoId, 'goal': goal});
  final data = Map<String, dynamic>.from(response.data as Map);
  return (data['subtasks'] as List)
      .map((m) => Subtask.fromMap(Map<String, dynamic>.from(m)))
      .toList();
}
```

### 8.10 Embedding + Firestore Vector Search

OpenAI embedding 直接呼叫：

```ts
// tools/embedding.ts
import { getOpenAI, MODELS } from '../config';
import { FieldValue } from 'firebase-admin/firestore';

export async function embed(text: string): Promise<number[]> {
  const res = await getOpenAI().embeddings.create({
    model: MODELS.embedding,
    input: text,
  });
  return res.data[0].embedding;
}
```

存入 Firestore 用 Vector 型別（Firestore 2024 起原生支援）：

```ts
import { FieldValue } from 'firebase-admin/firestore';

await db.collection('apps/gitsync/repos').doc(repoId)
  .collection('commits').doc(sha).set({
    message: commitMessage,
    messageEmbedding: FieldValue.vector(await embed(commitMessage)),  // ← 原生向量
    // ...
  });
```

查詢（KNN）：

```ts
const query = await db.collection('apps/gitsync/repos').doc(repoId)
  .collection('commits')
  .findNearest({
    vectorField: 'messageEmbedding',
    queryVector: FieldValue.vector(await embed(searchText)),
    limit: 5,
    distanceMeasure: 'COSINE',
  })
  .get();
```

**注意**：用 `findNearest` 前需要在 Firestore 建 vector index：
```bash
gcloud firestore indexes composite create \
  --collection-group=commits \
  --query-scope=COLLECTION \
  --field-config field-path=messageEmbedding,vector-config='{"dimension":1536,"flat":{}}'
```

### 8.11 Prompt Caching（省 token）

OpenAI 對 ≥1024 tokens 的 prompt prefix 自動 cache（無需設定，自動省 50%）。**設計 prompt 時把不變的 system prompt + project context 放最前面**。

---

## 9. Theme

來源：
- [`meals-app-animation/lib/main.dart`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-meals-app-animation/lib/main.dart)
- 你們的 prototype `references/GitSync/src/app/theme.ts`

### 9.1 課程作法：`ThemeData` + `ColorScheme.fromSeed` + `GoogleFonts`

```dart
final theme = ThemeData(
  useMaterial3: true,
  colorScheme: ColorScheme.fromSeed(
    brightness: Brightness.light,
    seedColor: const Color(0xFF1565C0),  // GitSync 主題色（深藍）
  ),
  textTheme: GoogleFonts.notoSansTcTextTheme(),  // 支援繁中
);
```

### 9.2 用 ColorScheme 而非 hardcode 顏色

```dart
Text('Steps',
  style: Theme.of(ctx).textTheme.titleLarge!.copyWith(
    color: Theme.of(ctx).colorScheme.primary,
    fontWeight: FontWeight.bold,
  ),
);
```

### 9.3 Dark mode 切換

把 light / dark `ThemeData` 都註冊到 `MaterialApp`：

```dart
return MaterialApp.router(
  theme: lightTheme,
  darkTheme: darkTheme,
  themeMode: themeModeNotifier.mode,   // ChangeNotifier 控制
  routerConfig: routerConfig,
);
```

---

## 10. 動畫

來源：[`meals-app-animation/lib/widgets/meal_details_page.dart`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-meals-app-animation/lib/widgets/meal_details_page.dart)

### 10.1 AnimatedList（List 進出動畫）

來源：[`group-todo-list-example/lib/views/todo_list_page.dart`](../../my_dir/NTHU/Software Studio/old/software_design/lab-flutter-basics-dart-group-todo-list-example/lib/views/todo_list_page.dart)

```dart
final _listKey = GlobalKey<AnimatedListState>();

AnimatedList(
  key: _listKey,
  initialItemCount: _computeInitItemCount(vm),
  itemBuilder: (ctx, index, animation) => FadeTransition(
    opacity: CurvedAnimation(
      parent: animation,
      curve: const Interval(0.5, 1.0, curve: Curves.easeOut),
    ),
    child: SizeTransition(
      sizeFactor: CurvedAnimation(parent: animation, curve: Curves.easeOut),
      child: TodoListTile(item: vm.items[index], ...),
    ),
  ),
);

// 新增動畫
WidgetsBinding.instance.addPostFrameCallback((_) {
  _listKey.currentState?.insertItem(0, duration: const Duration(milliseconds: 300));
});

// 刪除動畫
_listKey.currentState?.removeItem(
  index,
  (ctx, animation) => _buildAnimatedTile(ctx, vm, index, animation, animatedItem: removedItem),
  duration: const Duration(milliseconds: 300),
);
```

### 10.2 Hero（頁面間轉場）

```dart
// 在 list page
Hero(tag: task.id, child: Image.network(task.coverUrl, fit: BoxFit.cover))

// 在 detail page (tag 必須相同)
Hero(tag: task.id, child: Image.network(task.coverUrl, fit: BoxFit.cover))
```

### 10.3 SliverAppBar（折疊式 AppBar，跟 prototype 的任務細節頁一致）

```dart
CustomScrollView(
  slivers: [
    SliverAppBar(
      expandedHeight: 240.0,
      pinned: true,
      stretch: true,
      flexibleSpace: FlexibleSpaceBar(
        background: Hero(tag: task.id, child: Image.network(...)),
      ),
    ),
    SliverList(delegate: SliverChildListDelegate([...])),
  ],
);
```

### 10.4 AnimatedSwitcher（icon 切換動畫，課程示範的「星星」效果）

```dart
AnimatedSwitcher(
  duration: const Duration(milliseconds: 300),
  transitionBuilder: (child, animation) {
    final isEntering = child.key == ValueKey(isFavorite);
    return FadeTransition(
      opacity: animation,
      child: RotationTransition(
        turns: Tween<double>(begin: 0, end: 0.4).animate(
          isEntering ? animation : ReverseAnimation(animation),
        ),
        child: child,
      ),
    );
  },
  child: Icon(isFavorite ? Icons.star : Icons.star_border,
              key: ValueKey(isFavorite)),  // ← key 一定要不同
);
```

---

## 11. 表單

```dart
final _formKey = GlobalKey<FormState>();
String _enteredName = '';

Form(
  key: _formKey,
  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    TextFormField(
      decoration: InputDecoration(
        labelText: 'Name',
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8.0)),
      ),
      validator: (v) => (v == null || v.trim().length < 2) ? 'Invalid' : null,
      onSaved: (v) => _enteredName = v!,
    ),
    FilledButton(onPressed: _submit, child: const Text('Submit')),
  ]),
);

Future<void> _submit() async {
  if (!_formKey.currentState!.validate()) return;
  _formKey.currentState!.save();
  // ... call viewModel.addX()
}
```

---

## 12. 錯誤處理 / 非同步守則

**所有跨 async gap 的 BuildContext 使用前都要檢查 `mounted`**：

```dart
try {
  await viewModel.addItem(newItem);
  if (mounted) {                                          // ← 必檢
    Provider.of<NavigationService>(context, listen: false).goRepos();
  }
} on TimeoutException catch (e) {
  if (mounted) {
    ScaffoldMessenger.of(context).clearSnackBars();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Operation timed out: ${e.message}')),
    );
  }
}
```

Repository 層的所有寫入加 `.timeout(timeout)`：
```dart
await docRef.set(map).timeout(const Duration(seconds: 10));
```

---

## 13. 不要做 / 避免

- ❌ 不要用 `setState` 跨頁傳資料 — 用 Provider
- ❌ View 不要直接 import Repository — 透過 ViewModel
- ❌ Firestore trigger 不要少 idempotency check
- ❌ 不要 hardcode 顏色字串 — 用 `Theme.of(ctx).colorScheme.X`
- ❌ 不要混用 Navigator 1.0 (`Navigator.push`) 與 GoRouter — 全程用 GoRouter (`router.go`)
- ❌ 不要在 `build()` 裡呼叫 `Provider.of(..., listen: false)` 之外的副作用
- ❌ 不要忘記在 `dispose()` cancel `StreamSubscription`

---

## 14. 必裝的 dev 工具與步驟

```bash
# Firebase 設定
npm install -g firebase-tools
firebase login
flutter pub global activate flutterfire_cli
flutterfire configure                    # 產生 firebase_options.dart

# Functions
cd functions
npm install
npm run deploy                            # firebase deploy --only functions

# Firestore rules
firebase deploy --only firestore:rules
```

---

## 15. 與 prototype 對照表

| Prototype 畫面 (`references/GitSync/src/app/pages/`) | Flutter 對應 |
|---|---|
| `SignIn.tsx` | `views/sign_in_page.dart` (Firebase Auth + GitHub OAuth) |
| `RepoList.tsx` | `views/repo_list_page.dart` (stream from `apps/gitsync/users/{uid}/repos`) |
| `AddRepo.tsx` | `views/add_repo_page.dart` (form + 驗證 GitHub repo URL) |
| `tasks/TasksBoard.tsx` | `views/tasks/tasks_board_page.dart` (看板 + 關聯圖兩個 Tab) |
| `tasks/AddTodo.tsx` | `views/tasks/add_todo_page.dart` (三步驟：輸入 → AI 生成 → 確認) |
| `tasks/TaskDetails.tsx` | `views/tasks/task_details_page.dart` (含 AI 生成的交接區塊) |
| `daily/DailyView.tsx` | `views/daily/daily_view_page.dart` (日報 / commit / DC 群三個 Tab) |
| `stats/StatsView.tsx` | `views/stats/stats_view_page.dart` (貢獻度圓餅 + 進度長條) |
| `Settings.tsx` | `views/settings_page.dart` |

Theme 對照（prototype `theme.ts` → ColorScheme.fromSeed）：

| Prototype Token | Light Hex | Dark Hex | Flutter 對應 |
|---|---|---|---|
| `accent` | `#1565C0` | `#FAB28E` | `seedColor` (light/dark) |
| `bgPrimary` | `#EEF5FF` | `#1C1E26` | `surface` (auto-generated) |
| `textPrimary` | `#1A3A5C` | `#D5D8DA` | `onSurface` (auto-generated) |
| `success` | `#29D398` | `#29D398` | 自訂 extension |
| `warning` | `#FAB795` | `#FAB795` | 自訂 extension |
| `error` | `#E95678` | `#E95678` | `colorScheme.error` |

**建議**：因為 prototype 已選了特定品牌色，Flutter 用 `ColorScheme.fromSeed(seedColor: Color(0xFF1565C0))` 會自動生出 Material 3 配色；若要完全 1:1 對齊 prototype，再用 `ColorScheme(primary: ..., onPrimary: ..., ...)` 一個個手填。

---

> 本文件由 AI 整理自 `D:\my_dir\NTHU\Software Studio\old\software_design\` 下的考古題程式碼。若課程教材有新增章節，請更新此文件。
