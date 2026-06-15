import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../services/functions_service.dart';
import '../../services/navigation.dart';

// AddRepoPage — paste a GitHub URL, call `addRepo` callable, navigate to the
// new repo's tasks board.
// TODO: implement form + validation per prototype `AddRepo.tsx`.
class AddRepoPage extends StatefulWidget {
  const AddRepoPage({super.key});

  @override
  State<AddRepoPage> createState() => _AddRepoPageState();
}

class _AddRepoPageState extends State<AddRepoPage> {
  final _formKey = GlobalKey<FormState>();
  String _githubUrl = '';
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    _formKey.currentState!.save();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final fn = Provider.of<FunctionsService>(context, listen: false);
      final repoId = await fn.addRepo(githubUrl: _githubUrl);
      if (!mounted) return;
      Provider.of<NavigationService>(context, listen: false).goTasks(repoId);
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Add repo')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextFormField(
                decoration: const InputDecoration(
                  labelText: 'GitHub URL',
                  hintText: 'https://github.com/owner/repo',
                  border: OutlineInputBorder(),
                ),
                validator: (v) =>
                    (v == null || !v.contains('github.com'))
                        ? 'Invalid GitHub URL'
                        : null,
                onSaved: (v) => _githubUrl = v!.trim(),
              ),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: _busy ? null : _submit,
                child: Text(_busy ? 'Adding…' : 'Add'),
              ),
              if (_error != null) ...[
                const SizedBox(height: 16),
                Text(
                  _error!,
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
