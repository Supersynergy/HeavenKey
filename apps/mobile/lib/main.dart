import 'dart:async';

import 'package:flutter/material.dart';

import 'backup_panel.dart';
import 'vault_controller.dart';
import 'vault_entry.dart';

void main() => runApp(const HeavenKeyApp());

class HeavenKeyApp extends StatelessWidget {
  const HeavenKeyApp({super.key, this.controller});
  final VaultController? controller;
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'HeavenKey',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff3463df)),
      scaffoldBackgroundColor: const Color(0xfff5f7fa),
      inputDecorationTheme: const InputDecorationTheme(
        border: OutlineInputBorder(),
      ),
    ),
    darkTheme: ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: ColorScheme.fromSeed(
        seedColor: const Color(0xff9cbcff),
        brightness: Brightness.dark,
      ),
    ),
    home: VaultHome(controller: controller),
  );
}

class VaultHome extends StatefulWidget {
  const VaultHome({super.key, this.controller});
  final VaultController? controller;
  @override
  State<VaultHome> createState() => _VaultHomeState();
}

class _VaultHomeState extends State<VaultHome> with WidgetsBindingObserver {
  late final vault = widget.controller ?? VaultController();
  final search = TextEditingController();
  bool editing = false, covered = false;
  VaultEntry? selected;
  int tab = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    vault.addListener(changed);
    unawaited(vault.refreshStatus());
  }

  void changed() {
    if (!mounted) return;
    if (!vault.unlocked) {
      editing = false;
      selected = null;
      search.clear();
    }
    setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      unawaited(vault.lock());
    }
    if (state == AppLifecycleState.resumed) unawaited(vault.refreshStatus());
    setState(() {
      covered = state != AppLifecycleState.resumed;
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    vault.removeListener(changed);
    unawaited(vault.lock());
    if (widget.controller == null) vault.dispose();
    search.dispose();
    super.dispose();
  }

  void edit([VaultEntry? entry]) => setState(() {
    selected = entry;
    editing = true;
  });

  @override
  Widget build(BuildContext context) {
    final entries =
        vault.entries.where((entry) => entry.matches(search.text)).toList()
          ..sort(
            (a, b) => a.title.toLowerCase().compareTo(b.title.toLowerCase()),
          );
    return Scaffold(
      appBar: AppBar(
        title: const Text('HeavenKey'),
        leading: const Icon(Icons.key_rounded, color: Color(0xffab7c23)),
        actions: [
          if (vault.unlocked)
            IconButton(
              onPressed: () => vault.lock(),
              tooltip: 'Tresor sperren',
              icon: const Icon(Icons.lock_outline),
            ),
        ],
      ),
      body: covered
          ? const Center(child: Icon(Icons.lock_outline, size: 64))
          : SafeArea(
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 720),
                  child: Column(
                    children: [
                      if (vault.error != null)
                        Padding(
                          padding: const EdgeInsets.all(16),
                          child: Semantics(
                            liveRegion: true,
                            child: Text(
                              vault.error!,
                              style: TextStyle(
                                color: Theme.of(context).colorScheme.error,
                              ),
                            ),
                          ),
                        ),
                      if (vault.backupNotice != null)
                        Padding(
                          padding: const EdgeInsets.all(16),
                          child: Semantics(
                            liveRegion: true,
                            child: Text(vault.backupNotice!),
                          ),
                        ),
                      if (vault.busy) const LinearProgressIndicator(),
                      Expanded(
                        child: !vault.unlocked
                            ? locked()
                            : editing
                            ? EntryEditor(
                                key: ValueKey(selected?.id ?? 'new'),
                                entry: selected,
                                busy: vault.busy,
                                onCancel: () => setState(() {
                                  editing = false;
                                  selected = null;
                                }),
                                onSave: (entry) async {
                                  if (await vault.save(entry) && mounted) {
                                    setState(() {
                                      editing = false;
                                      selected = null;
                                    });
                                  }
                                },
                                onDelete: selected == null
                                    ? null
                                    : () async {
                                        final id = selected!.id;
                                        final confirmed =
                                            await showDialog<bool>(
                                              context: context,
                                              builder: (context) => AlertDialog(
                                                title: const Text(
                                                  'Eintrag löschen?',
                                                ),
                                                content: const Text(
                                                  'Dieser Eintrag wird vom Gerät entfernt.',
                                                ),
                                                actions: [
                                                  TextButton(
                                                    onPressed: () =>
                                                        Navigator.pop(
                                                          context,
                                                          false,
                                                        ),
                                                    child: const Text(
                                                      'Behalten',
                                                    ),
                                                  ),
                                                  TextButton(
                                                    onPressed: () =>
                                                        Navigator.pop(
                                                          context,
                                                          true,
                                                        ),
                                                    child: const Text(
                                                      'Löschen',
                                                    ),
                                                  ),
                                                ],
                                              ),
                                            );
                                        if (confirmed == true &&
                                            await vault.delete(id) &&
                                            mounted) {
                                          setState(() {
                                            editing = false;
                                            selected = null;
                                          });
                                        }
                                      },
                                onCopy: selected == null
                                    ? null
                                    : () async {
                                        if (await vault.copyPassword(
                                              selected!.id,
                                            ) &&
                                            context.mounted) {
                                          ScaffoldMessenger.of(context)
                                              .showSnackBar(
                                                const SnackBar(
                                                  content: Text(
                                                    'Passwort kopiert. Zwischenablage wird nach 30 Sekunden geleert.',
                                                  ),
                                                ),
                                              );
                                        }
                                      },
                              )
                            : switch (tab) {
                                1 => health(),
                                2 => autofill(),
                                3 => BackupPanel(vault: vault),
                                _ => entryList(entries),
                              },
                      ),
                    ],
                  ),
                ),
              ),
            ),
      floatingActionButton: vault.unlocked && !editing && tab == 0 && !covered
          ? FloatingActionButton.extended(
              onPressed: vault.busy ? null : () => edit(),
              icon: const Icon(Icons.add),
              label: const Text('Neuer Login'),
            )
          : null,
      bottomNavigationBar: vault.unlocked && !editing
          ? NavigationBar(
              selectedIndex: tab,
              onDestinationSelected: (value) => setState(() {
                tab = value;
              }),
              destinations: const [
                NavigationDestination(
                  icon: Icon(Icons.key_outlined),
                  label: 'Tresor',
                ),
                NavigationDestination(
                  icon: Icon(Icons.shield_outlined),
                  label: 'Prüfen',
                ),
                NavigationDestination(
                  icon: Icon(Icons.web_outlined),
                  label: 'Autofill',
                ),
                NavigationDestination(
                  icon: Icon(Icons.backup_outlined),
                  label: 'Sicherung',
                ),
              ],
            )
          : null,
    );
  }

  Widget locked() => ListView(
    padding: const EdgeInsets.all(28),
    children: [
      const SizedBox(height: 36),
      const Icon(Icons.key_rounded, size: 88, color: Color(0xffab7c23)),
      const SizedBox(height: 24),
      Text(
        'Deine Schlüssel.\nAuf deinem Gerät.',
        style: Theme.of(context).textTheme.headlineLarge,
      ),
      const SizedBox(height: 16),
      const Text(
        'Lokaler Tresor mit Gerätesperre. Passwörter werden nur nach deiner Freigabe an die passende Website übergeben.',
      ),
      const SizedBox(height: 28),
      FilledButton.icon(
        onPressed: vault.busy ? null : () => vault.unlock(),
        icon: const Icon(Icons.fingerprint),
        label: const Text('Tresor entsperren'),
      ),
      const SizedBox(height: 20),
      const Text(
        'Automatische Sperre nach einer Minute und beim Wechsel in den Hintergrund.',
      ),
      const SizedBox(height: 12),
      const Text(
        'Diese mobile Version speichert auf einem Gerät. Synchronisierung und Wiederherstellung aus dem Desktop-Tresor sind noch nicht verfügbar.',
      ),
    ],
  );

  Widget entryList(List<VaultEntry> entries) => Column(
    children: [
      Padding(
        padding: const EdgeInsets.all(16),
        child: TextField(
          controller: search,
          onChanged: (_) => setState(() {}),
          decoration: const InputDecoration(
            labelText: 'Logins suchen',
            prefixIcon: Icon(Icons.search),
          ),
        ),
      ),
      Expanded(
        child: entries.isEmpty
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(
                    vault.entries.isEmpty
                        ? 'Noch keine Logins. Lege deinen ersten Eintrag an.'
                        : 'Keine passenden Logins.',
                  ),
                ),
              )
            : ListView.builder(
                padding: const EdgeInsets.only(bottom: 96),
                itemCount: entries.length,
                itemBuilder: (context, index) {
                  final entry = entries[index];
                  return ListTile(
                    leading: const CircleAvatar(
                      child: Icon(Icons.key_outlined),
                    ),
                    title: Text(entry.title),
                    subtitle: Text('${entry.username}\n${entry.origin}'),
                    isThreeLine: true,
                    trailing: const Icon(Icons.chevron_right),
                    onTap: vault.busy ? null : () => edit(entry),
                  );
                },
              ),
      ),
    ],
  );

  Widget health() {
    final result = passwordHealth(vault.entries);
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Text(
          'Passwörter prüfen',
          style: Theme.of(context).textTheme.headlineMedium,
        ),
        const SizedBox(height: 16),
        ListTile(
          leading: const Icon(Icons.password),
          title: Text('${result.short} kurze Passwörter'),
          subtitle: const Text('Weniger als 16 Zeichen.'),
        ),
        ListTile(
          leading: const Icon(Icons.copy_all_outlined),
          title: Text('${result.reused} mehrfach verwendete Passwörter'),
          subtitle: const Text(
            'Ersetze gleiche Passwörter durch einzelne, zufällige Werte.',
          ),
        ),
        const SizedBox(height: 16),
        const Text(
          'Die Prüfung läuft lokal. Sie bewertet Länge und Wiederverwendung; sie fragt keine Datenleck-Datenbank ab.',
        ),
      ],
    );
  }

  Widget autofill() => ListView(
    padding: const EdgeInsets.all(24),
    children: [
      Text(
        'Im Browser ausfüllen',
        style: Theme.of(context).textTheme.headlineMedium,
      ),
      const SizedBox(height: 16),
      const Text(
        'Android prüft den Browser und die gemeldete HTTPS-Domain. Vor jeder Passwortfreigabe bestätigst du die Domain einmalig. Ports und eingebettete Formulare derselben Domain kann der Browser dabei nicht zuverlässig unterscheiden. Es entsteht keine dauerhafte Ausnahme.',
      ),
      const SizedBox(height: 24),
      FilledButton.icon(
        onPressed: vault.busy ? null : () => vault.enableAutofill(),
        icon: const Icon(Icons.settings_outlined),
        label: const Text('Autofill einrichten'),
      ),
      if (vault.status['platform'] == 'android') ...[
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: vault.busy || vault.status['browserTrusted'] != true
              ? null
              : () => vault.configureBrowser(),
          icon: const Icon(Icons.open_in_browser),
          label: const Text('Browser einrichten'),
        ),
      ],
      const SizedBox(height: 20),
      Text(
        vault.status['autofillEnabled'] == true
            ? 'HeavenKey ist im System als Autofill-Dienst ausgewählt.'
            : 'Wähle HeavenKey in den Systemeinstellungen als Autofill-Dienst.',
      ),
      const SizedBox(height: 16),
      const Text(
        'Chrome: In den Browsereinstellungen Autofill mit einem anderen Dienst aktivieren. Fehlt die Herkunft einzelner Eingabefelder, bleibt die Passwortfreigabe gesperrt. Ein aktueller Browser ist erforderlich.\n\niPhone: HeavenKey benötigt eine eindeutige HTTPS-Adresse. Bei unvollständigen Angaben bleibt die Passwortfreigabe gesperrt. Die iPhone-Geräteabnahme steht noch aus.',
      ),
    ],
  );
}

typedef SaveEntry = Future<void> Function(VaultEntry entry);

class EntryEditor extends StatefulWidget {
  const EntryEditor({
    super.key,
    this.entry,
    required this.busy,
    required this.onSave,
    required this.onCancel,
    this.onDelete,
    this.onCopy,
  });
  final VaultEntry? entry;
  final bool busy;
  final SaveEntry onSave;
  final VoidCallback onCancel;
  final Future<void> Function()? onDelete, onCopy;
  @override
  State<EntryEditor> createState() => _EntryEditorState();
}

class _EntryEditorState extends State<EntryEditor> {
  final form = GlobalKey<FormState>();
  late final title = TextEditingController(text: widget.entry?.title ?? '');
  late final origin = TextEditingController(
    text: widget.entry?.origin ?? 'https://',
  );
  late final username = TextEditingController(
    text: widget.entry?.username ?? '',
  );
  late final password = TextEditingController(
    text: widget.entry?.password ?? '',
  );
  late final notes = TextEditingController(text: widget.entry?.notes ?? '');
  bool reveal = false;
  @override
  void dispose() {
    for (final field in [title, origin, username, password, notes]) {
      field.clear();
      field.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Form(
    key: form,
    child: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(
          widget.entry == null ? 'Neuer Login' : 'Login bearbeiten',
          style: Theme.of(context).textTheme.headlineMedium,
        ),
        const SizedBox(height: 20),
        TextFormField(
          controller: title,
          maxLength: 120,
          decoration: const InputDecoration(labelText: 'Name'),
          validator: (value) =>
              value == null || value.trim().isEmpty ? 'Name eingeben.' : null,
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: origin,
          maxLength: 2048,
          keyboardType: TextInputType.url,
          autocorrect: false,
          decoration: const InputDecoration(
            labelText: 'HTTPS-Website',
            hintText: 'https://example.com',
          ),
          validator: (value) {
            try {
              canonicalOrigin(value ?? '');
              return null;
            } on FormatException {
              return 'Gültige HTTPS-Domain ohne Pfad eingeben.';
            }
          },
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: username,
          maxLength: 320,
          autocorrect: false,
          enableSuggestions: false,
          decoration: const InputDecoration(
            labelText: 'Benutzername oder E-Mail',
          ),
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: password,
          maxLength: 1024,
          obscureText: !reveal,
          autocorrect: false,
          enableSuggestions: false,
          enableIMEPersonalizedLearning: false,
          decoration: InputDecoration(
            labelText: 'Passwort',
            suffixIcon: IconButton(
              tooltip: reveal ? 'Passwort verbergen' : 'Passwort anzeigen',
              onPressed: () => setState(() {
                reveal = !reveal;
              }),
              icon: Icon(reveal ? Icons.visibility_off : Icons.visibility),
            ),
          ),
          validator: (value) => value == null || value.isEmpty
              ? 'Passwort eingeben oder erzeugen.'
              : null,
        ),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: widget.busy
                ? null
                : () => setState(() {
                    password.text = generatePassword();
                  }),
            icon: const Icon(Icons.auto_fix_high_outlined),
            label: const Text('Zufälliges Passwort erzeugen'),
          ),
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: notes,
          maxLength: 4096,
          maxLines: 3,
          enableIMEPersonalizedLearning: false,
          decoration: const InputDecoration(labelText: 'Notizen'),
        ),
        const SizedBox(height: 20),
        FilledButton(
          onPressed: widget.busy
              ? null
              : () async {
                  if (!form.currentState!.validate()) return;
                  await widget.onSave(
                    VaultEntry(
                      id: widget.entry?.id ?? newEntryId(),
                      title: title.text.trim(),
                      origin: canonicalOrigin(origin.text),
                      username: username.text,
                      password: password.text,
                      notes: notes.text,
                      updatedAt: DateTime.now().toUtc().toIso8601String(),
                    ),
                  );
                },
          child: const Text('Login speichern'),
        ),
        TextButton(
          onPressed: widget.busy ? null : widget.onCancel,
          child: const Text('Zurück'),
        ),
        if (widget.onCopy != null)
          OutlinedButton.icon(
            onPressed: widget.busy ? null : widget.onCopy,
            icon: const Icon(Icons.copy),
            label: const Text('Gespeichertes Passwort kopieren'),
          ),
        if (widget.onDelete != null)
          TextButton(
            onPressed: widget.busy ? null : widget.onDelete,
            child: const Text('Eintrag löschen'),
          ),
      ],
    ),
  );
}
