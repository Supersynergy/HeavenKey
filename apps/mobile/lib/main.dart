import 'dart:async';

import 'package:flutter/material.dart';

import 'backup_panel.dart';
import 'connected_panel.dart';
import 'mobile_theme.dart';
import 'passkeys_panel.dart';
import 'vault_controller.dart';
import 'vault_entry.dart';
import 'website_input.dart';

void main() => runApp(const HeavenKeyApp());

class HeavenKeyApp extends StatelessWidget {
  const HeavenKeyApp({super.key, this.controller});
  final VaultController? controller;
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'HeavenKey',
    debugShowCheckedModeBanner: false,
    theme: heavenKeyTheme(Brightness.light),
    darkTheme: heavenKeyTheme(Brightness.dark),
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
  bool editing = false, covered = false, firstLoginSaved = false;
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
      firstLoginSaved = false;
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
    return PopScope(
      canPop: !editing,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && editing) closeEditor();
      },
      child: Scaffold(
        appBar: AppBar(
          title: const Text('HeavenKey'),
          leading: editing
              ? IconButton(
                  tooltip: 'Zurück zum Tresor',
                  onPressed: vault.busy ? null : closeEditor,
                  icon: const Icon(Icons.arrow_back),
                )
              : const Icon(Icons.key_rounded, color: Color(0xffab7c23)),
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
                                  usernameHints: vault.entries
                                      .map((entry) => entry.username)
                                      .where((value) => value.trim().isNotEmpty)
                                      .toSet()
                                      .take(3)
                                      .toList(),
                                  busy: vault.busy,
                                  onCancel: closeEditor,
                                  onSave: (entry) async {
                                    final wasEmpty = vault.entries.isEmpty;
                                    if (await vault.save(entry) && mounted) {
                                      setState(() {
                                        editing = false;
                                        selected = null;
                                        if (wasEmpty) firstLoginSaved = true;
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
                                                builder: (context) =>
                                                    AlertDialog(
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
                                  1 => PasskeysPanel(vault: vault),
                                  2 => autofill(),
                                  3 => BackupPanel(vault: vault),
                                  4 => ConnectedPanel(vault: vault),
                                  _ => entryList(entries),
                                },
                        ),
                      ],
                    ),
                  ),
                ),
              ),
        floatingActionButton:
            vault.unlocked &&
                vault.entries.isNotEmpty &&
                !editing &&
                tab == 0 &&
                !covered
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
                    icon: Icon(Icons.fingerprint),
                    selectedIcon: Icon(Icons.fingerprint),
                    label: 'Passkeys',
                  ),
                  NavigationDestination(
                    icon: Icon(Icons.web_outlined),
                    label: 'Autofill',
                  ),
                  NavigationDestination(
                    icon: Icon(Icons.backup_outlined),
                    label: 'Sicherung',
                  ),
                  NavigationDestination(
                    icon: Icon(Icons.devices_outlined),
                    label: 'Geräte',
                  ),
                ],
              )
            : null,
      ),
    );
  }

  void closeEditor() {
    if (!vault.unlocked) return;
    setState(() {
      editing = false;
      selected = null;
    });
  }

  Widget locked() {
    final colors = Theme.of(context).colorScheme;
    final firstStart = vault.status['hasVault'] == false;
    final needsLock =
        vault.status['available'] == true &&
        vault.status['secureDevice'] == false;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 20, 24, 32),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.all(28),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(28),
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [colors.primaryContainer, colors.surface],
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.key_rounded, size: 56, color: colors.primary),
                const SizedBox(height: 28),
                Text(
                  'Deine Schlüssel.\nEinfach bei dir.',
                  style: Theme.of(context).textTheme.headlineLarge?.copyWith(
                    fontWeight: FontWeight.w700,
                    letterSpacing: -1,
                  ),
                ),
                const SizedBox(height: 14),
                const Text(
                  'Dein eigenständiger Tresor auf dem Handy. Ohne Cloudkonto, ohne Computer und ohne zusätzliches Masterpasswort.',
                ),
                const SizedBox(height: 28),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: vault.busy || needsLock
                        ? null
                        : () => vault.unlock(),
                    icon: const Icon(Icons.fingerprint),
                    label: Text(
                      firstStart
                          ? 'Auf diesem Handy starten'
                          : 'Tresor entsperren',
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                const Text(
                  'Fingerabdruck oder sichere Gerätesperre bestätigen.',
                ),
              ],
            ),
          ),
          if (needsLock) ...[
            const SizedBox(height: 20),
            VaultBanner(
              icon: Icons.phonelink_lock,
              title: 'Einmal das Handy absichern',
              message: 'Richte zuerst PIN, Passwort oder Muster als Gerätesperre ein. Danach kannst du deinen Tresor öffnen.',
              child: FilledButton.icon(
                onPressed: vault.busy ? null : vault.configureDeviceSecurity,
                icon: const Icon(Icons.settings_outlined),
                label: const Text('Gerätesperre einrichten'),
              ),
            ),
          ],
          const SizedBox(height: 24),
          const ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.lock_outline),
            title: Text('Lokal verschlüsselt'),
            subtitle: Text(
              'Automatisch gesperrt nach einer Minute und im Hintergrund.',
            ),
          ),
          const ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.auto_awesome_outlined),
            title: Text('Weniger merken. Entspannter anmelden.'),
            subtitle: Text(
              'Passwörter erzeugen und ausfüllen. Passkeys auf unterstützten Websites verwenden.',
            ),
          ),
          const SizedBox(height: 12),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: const Text('Vorhandene Daten übernehmen'),
            children: const [
              Padding(
                padding: EdgeInsets.only(bottom: 16),
                child: Text(
                  'Entsperre zuerst mit deiner Gerätesperre. Unter Sicherung kannst du eine Datei wiederherstellen. Unter Geräte lässt sich dein Desktop optional verbinden.',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget entryList(List<VaultEntry> entries) => Column(
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Alles Wichtige. Bei dir.',
              style: Theme.of(context).textTheme.headlineSmall
                  ?.copyWith(fontWeight: FontWeight.w700, letterSpacing: -0.5),
            ),
            const SizedBox(height: 6),
            Text(
              '${vault.entries.length} Logins · Lokal auf diesem Gerät',
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 18),
            TextField(
              controller: search,
              onChanged: (_) => setState(() {}),
              autocorrect: false,
              enableSuggestions: false,
              enableIMEPersonalizedLearning: false,
              decoration: InputDecoration(
                labelText: 'Logins suchen',
                prefixIcon: const Icon(Icons.search),
                suffixIcon: search.text.isEmpty
                    ? null
                    : IconButton(
                        tooltip: 'Suche leeren',
                        onPressed: () => setState(search.clear),
                        icon: const Icon(Icons.close),
                      ),
              ),
            ),
          ],
        ),
      ),
      Expanded(
        child: vault.entries.isEmpty
            ? SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 100),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    VaultBanner(
                      icon: Icons.key_outlined,
                      title: 'Dein Tresor ist leer',
                      message: 'In drei Feldern zum ersten Login: Website, Benutzername und Passwort. Der Name entsteht automatisch.',
                      child: SizedBox(
                        width: double.infinity,
                        child: FilledButton.icon(
                          onPressed: vault.busy ? null : () => edit(),
                          icon: const Icon(Icons.add),
                          label: const Text('Ersten Login speichern'),
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    OutlinedButton.icon(
                      onPressed: vault.busy
                          ? null
                          : () => setState(() => tab = 3),
                      icon: const Icon(Icons.backup_outlined),
                      label: const Text('Sicherung wiederherstellen'),
                    ),
                    TextButton.icon(
                      onPressed: vault.busy
                          ? null
                          : () => setState(() => tab = 4),
                      icon: const Icon(Icons.devices_outlined),
                      label: const Text('Vom Desktop übernehmen'),
                    ),
                  ],
                ),
              )
            : entries.isEmpty
            ? Center(
                child: TextButton(
                  onPressed: () => setState(search.clear),
                  child: const Text('Keine passenden Logins. Suche leeren'),
                ),
              )
            : ListView.separated(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 100),
                itemCount: entries.length + (firstLoginSaved ? 1 : 0),
                separatorBuilder: (_, _) => const SizedBox(height: 8),
                itemBuilder: (context, index) {
                  if (firstLoginSaved && index == 0) return firstSaveHelp();
                  final entry = entries[index - (firstLoginSaved ? 1 : 0)];
                  final colors = Theme.of(context).colorScheme;
                  return Card(
                    clipBehavior: Clip.antiAlias,
                    child: ListTile(
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 8,
                      ),
                      leading: CircleAvatar(
                        backgroundColor: colors.primaryContainer,
                        foregroundColor: colors.onPrimaryContainer,
                        child: Text(entry.title.characters.first.toUpperCase()),
                      ),
                      title: Text(
                        entry.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        '${entry.username}\n${entry.origin}',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      isThreeLine: true,
                      trailing: const Icon(Icons.chevron_right),
                      onTap: vault.busy ? null : () => edit(entry),
                    ),
                  );
                },
              ),
      ),
    ],
  );

  Widget firstSaveHelp() => Card(
    margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Dein erster Login ist gespeichert',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          const Text(
            'Richte Autofill für den Browser ein und erstelle eine verschlüsselte Sicherung. Speichere den Wiederherstellungsschlüssel getrennt.',
          ),
          Wrap(
            spacing: 8,
            children: [
              TextButton(
                onPressed: () => setState(() => tab = 2),
                child: const Text('Autofill einrichten'),
              ),
              TextButton(
                onPressed: () => setState(() => tab = 3),
                child: const Text('Sicherung erstellen'),
              ),
              TextButton(
                onPressed: () => setState(() => firstLoginSaved = false),
                child: const Text('Hinweis schließen'),
              ),
            ],
          ),
        ],
      ),
    ),
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
      Card(
        child: ListTile(
          leading: const Icon(Icons.verified_user_outlined),
          title: const Text('Passwort-Check auf deinem Gerät'),
          subtitle: Text(
            '${passwordHealth(vault.entries).short} kurze · ${passwordHealth(vault.entries).reused} mehrfach verwendete Passwörter',
          ),
        ),
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
    this.usernameHints = const [],
  });
  final VaultEntry? entry;
  final bool busy;
  final SaveEntry onSave;
  final VoidCallback onCancel;
  final Future<void> Function()? onDelete, onCopy;
  final List<String> usernameHints;
  @override
  State<EntryEditor> createState() => _EntryEditorState();
}

class _EntryEditorState extends State<EntryEditor> {
  final form = GlobalKey<FormState>();
  late final title = TextEditingController(text: widget.entry?.title ?? '');
  late final origin = TextEditingController(text: widget.entry?.origin ?? '');
  late final username = TextEditingController(
    text: widget.entry?.username ?? '',
  );
  late final password = TextEditingController(
    text: widget.entry?.password ?? '',
  );
  late final notes = TextEditingController(text: widget.entry?.notes ?? '');
  bool reveal = false, generated = false;
  int passwordLength = 24;
  late bool showName = widget.entry != null;
  late bool showNotes = notes.text.isNotEmpty;

  String? get storedOrigin {
    try {
      return originFromWebsiteInput(origin.text);
    } on FormatException {
      return null;
    }
  }

  Future<void> generate() async {
    final previous = password.text;
    if (previous.isNotEmpty) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Passwort ersetzen?'),
          content: const Text(
            'Das eingegebene Passwort wird durch einen zufälligen Wert ersetzt. Dein Konto bei der Website wird dadurch nicht geändert.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Behalten'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Passwort ersetzen'),
            ),
          ],
        ),
      );
      if (confirmed != true ||
          !mounted ||
          widget.busy ||
          password.text != previous) {
        return;
      }
    }
    setState(() {
      password.text = generatePassword(passwordLength);
      generated = true;
    });
  }

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
    child: Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  widget.entry == null ? 'Neuer Login' : 'Login bearbeiten',
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
                const SizedBox(height: 20),
                const Text(
                  'Speichere die Zugangsdaten deines bestehenden Kontos. Ein neues Konto entsteht auf der Website.',
                ),
                const SizedBox(height: 16),
                TextFormField(
                  controller: origin,
                  maxLength: 2048,
                  enabled: !widget.busy,
                  enableIMEPersonalizedLearning: false,
                  textInputAction: TextInputAction.next,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  enableSuggestions: false,
                  onChanged: (_) => setState(() {}),
                  decoration: const InputDecoration(
                    labelText: 'HTTPS-Website',
                    hintText: 'example.com oder https://example.com/login',
                  ),
                  validator: (value) {
                    try {
                      originFromWebsiteInput(value ?? '');
                      return null;
                    } on FormatException {
                      return 'HTTPS-Domain eingeben, ohne Zugangsdaten oder IP-Adresse.';
                    }
                  },
                ),
                if (storedOrigin != null) ...[
                  Text('Gespeichert wird: $storedOrigin'),
                  const Text(
                    'Pfad, Suchparameter und Fragment werden weggelassen.',
                  ),
                ],
                const SizedBox(height: 12),
                TextFormField(
                  controller: username,
                  maxLength: 320,
                  enabled: !widget.busy,
                  textInputAction: TextInputAction.next,
                  autocorrect: false,
                  enableSuggestions: false,
                  enableIMEPersonalizedLearning: false,
                  onChanged: (_) => setState(() {}),
                  decoration: const InputDecoration(
                    labelText: 'Benutzername oder E-Mail',
                  ),
                ),
                if (username.text.isEmpty &&
                    widget.usernameHints.isNotEmpty) ...[
                  const Text('Benutzernamen aus diesem Tresor auswählen:'),
                  Wrap(
                    spacing: 8,
                    children: [
                      for (final hint in widget.usernameHints)
                        ActionChip(
                          label: Text(hint),
                          onPressed: widget.busy
                              ? null
                              : () => setState(() => username.text = hint),
                        ),
                    ],
                  ),
                ],
                const SizedBox(height: 12),
                TextFormField(
                  controller: password,
                  maxLength: 1024,
                  enabled: !widget.busy,
                  obscureText: !reveal,
                  autocorrect: false,
                  enableSuggestions: false,
                  enableIMEPersonalizedLearning: false,
                  onChanged: (_) => setState(() => generated = false),
                  decoration: InputDecoration(
                    labelText: 'Passwort',
                    helperText: 'Das aktuelle Passwort deines Website-Kontos.',
                    helperMaxLines: 2,
                    suffixIcon: IconButton(
                      tooltip: reveal
                          ? 'Passwort verbergen'
                          : 'Passwort anzeigen',
                      onPressed: () => setState(() {
                        reveal = !reveal;
                      }),
                      icon: Icon(
                        reveal ? Icons.visibility_off : Icons.visibility,
                      ),
                    ),
                  ),
                  validator: (value) => value == null || value.isEmpty
                      ? 'Passwort eingeben oder erzeugen.'
                      : null,
                ),
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    for (final length in [16, 24, 32, 48])
                      ChoiceChip(
                        label: Text('$length Zeichen'),
                        selected: passwordLength == length,
                        onSelected: widget.busy
                            ? null
                            : (_) => setState(() => passwordLength = length),
                      ),
                  ],
                ),
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: widget.busy ? null : generate,
                    icon: const Icon(Icons.auto_fix_high_outlined),
                    label: const Text('Zufälliges Passwort erzeugen'),
                  ),
                ),
                if (generated)
                  const Text(
                    'Ändere das Passwort auch bei der Website. Speichern allein ändert dein Konto nicht.',
                  ),
                const SizedBox(height: 12),
                if (!showName)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: widget.busy
                          ? null
                          : () => setState(() => showName = true),
                      icon: const Icon(Icons.tune),
                      label: const Text('Eigenen Namen vergeben'),
                    ),
                  ),
                if (showName) ...[
                  TextFormField(
                    controller: title,
                    maxLength: 120,
                    decoration: const InputDecoration(
                      labelText: 'Name',
                      helperText:
                          'Leer lassen: Website-Domain als Name verwenden.',
                    ),
                    validator: (value) =>
                        (value ?? '').trim().isEmpty &&
                            storedOrigin != null &&
                            Uri.parse(storedOrigin!).host.length > 120
                        ? 'Einen Namen mit höchstens 120 Zeichen eingeben.'
                        : null,
                  ),
                  const SizedBox(height: 12),
                ],
                if (!showNotes)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: widget.busy
                          ? null
                          : () => setState(() => showNotes = true),
                      icon: const Icon(Icons.notes_outlined),
                      label: const Text('Notiz hinzufügen'),
                    ),
                  ),
                if (showNotes)
                  TextFormField(
                    controller: notes,
                    maxLength: 4096,
                    maxLines: 3,
                    enableIMEPersonalizedLearning: false,
                    decoration: const InputDecoration(labelText: 'Notizen'),
                  ),
                const SizedBox(height: 20),
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
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FilledButton(
                onPressed: widget.busy
                    ? null
                    : () async {
                        if (!form.currentState!.validate()) return;
                        await widget.onSave(
                          VaultEntry(
                            id: widget.entry?.id ?? newEntryId(),
                            title: title.text.trim().isEmpty
                                ? Uri.parse(storedOrigin!).host
                                : title.text.trim(),
                            origin: storedOrigin!,
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
            ],
          ),
        ),
      ],
    ),
  );
}
