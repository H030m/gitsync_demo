import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../services/auth_service.dart';

/// Sign-up / login form. Toggles between the two modes.
class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _name = TextEditingController();
  final _email = TextEditingController();
  bool _isSignUp = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    super.dispose();
  }

  void _submit() {
    final auth = context.read<AuthService>();
    try {
      if (_isSignUp) {
        auth.signUp(name: _name.text.trim(), email: _email.text.trim());
      } else {
        auth.login(email: _email.text.trim());
      }
      if (mounted) context.pop();
    } on StateError catch (e) {
      setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_isSignUp ? '註冊' : '登入')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_isSignUp)
                  TextField(
                    controller: _name,
                    decoration: const InputDecoration(labelText: '姓名'),
                  ),
                TextField(
                  controller: _email,
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(labelText: 'Email'),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    _error!,
                    style: TextStyle(color: Theme.of(context).colorScheme.error),
                  ),
                ],
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: _submit,
                  child: Text(_isSignUp ? '註冊並登入' : '登入'),
                ),
                TextButton(
                  onPressed: () => setState(() {
                    _isSignUp = !_isSignUp;
                    _error = null;
                  }),
                  child: Text(_isSignUp ? '已有帳號？登入' : '還沒有帳號？註冊'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// [feat] 登入/註冊：Email 註冊、登入、登出並保存目前使用者，含重複註冊與查無帳號提示。

// [feat] 登入/註冊：Email 註冊、登入、登出並保存目前使用者，含重複註冊與查無帳號提示。

// 登入/註冊頁：表單、模式切換、重複註冊與查無帳號錯誤提示。

// 登入/註冊頁：表單、模式切換、重複註冊與查無帳號錯誤提示。

// 登入/註冊頁：表單、模式切換、重複註冊與查無帳號錯誤提示。

// 登入/註冊頁：表單、模式切換、重複註冊與查無帳號錯誤提示。

// 登入/註冊頁：表單、模式切換、重複註冊與查無帳號錯誤提示。

// 登入/註冊頁：表單、模式切換、重複註冊與查無帳號錯誤提示。

// 登入/註冊頁：表單、模式切換、重複註冊與查無帳號錯誤提示。

// 登入/註冊頁：表單、模式切換、重複註冊與查無帳號錯誤提示。

// 登入/註冊頁：表單、模式切換、重複註冊與查無帳號錯誤提示。

// 登入/註冊頁：表單、模式切換、重複註冊與查無帳號錯誤提示。

// 登入/註冊頁：表單、模式切換、重複註冊與查無帳號錯誤提示。

// 登入/註冊頁：表單、模式切換、重複註冊與查無帳號錯誤提示。
