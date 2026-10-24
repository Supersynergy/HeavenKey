import 'dart:async';

import 'package:flutter/material.dart';

import 'backup_preview.dart';
import 'vault_controller.dart';

class BackupPanel extends StatefulWidget {
  const BackupPanel({super.key, required this.vault});
  final VaultController vault;

  @override
  State<BackupPanel> createState() => _BackupPanelState();
}

class _BackupPanelState extends State<BackupPanel> {
  final _restoreKey = TextEditingController();
  String? _exportKey, _archive, _notice;
  BackupPreview? _preview;
  bool _keySaved = false, _replaceExisting = false, _confirming = false;
  int _epoch = 0;

  @override
  void initState() {
    super.initState();
    _archive = widget.vault.selectedBackup;
    widget.vault.addListener(_vaultChanged);
    _restoreKey.addListener(_keyChanged);
  }

  bool _current(int epoch) =>
      mounted && widget.vault.unlocked && epoch == _epoch;

  void _clearSecrets() {
    _epoch++;
    _exportKey = null;
    _preview = null;
    _keySaved = false;
    _replaceExisting = false;
    _confirming = false;
    _notice = null;
    _restoreKey.clear();
  }

  void _vaultChanged() {
    if (!mounted) return;
    if (!widget.vault.unlocked || widget.vault.selectedBackup != _archive) {
      _clearSecrets();
      _archive = widget.vault.selectedBackup;
    }
    setState(() {});
  }

  void _keyChanged() {
    if (!mounted) return;
    setState(() {
      _epoch++;
      _preview = null;
      _replaceExisting = false;
      _confirming = false;
    });
  }

  @override
  void didUpdateWidget(covariant BackupPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.vault != widget.vault) {
      oldWidget.vault.removeListener(_vaultChanged);
      _clearSecrets();
      _archive = widget.vault.selectedBackup;
      widget.vault.addListener(_vaultChanged);
    }
  }

  @override
  void dispose() {
    widget.vault.removeListener(_vaultChanged);
    _restoreKey.removeListener(_keyChanged);
    _clearSecrets();
    _restoreKey.dispose();
    super.dispose();
  }

  Future<void> _generateKey() async {
    final epoch = _epoch;
    setState(() {
      _exportKey = null;
      _keySaved = false;
      _notice = null;
    });
    final key = await widget.vault.newBackupKey();
    if (!_current(epoch)) return;
    setState(() => _exportKey = key);
  }

  Future<void> _copyKey() async {
    final key = _exportKey;
    if (key == null) return;
    final epoch = _epoch;
    final copied = await widget.vault.copyBackupKey(key);
    if (!_current(epoch) || !copied) return;
    setState(() {
      _notice = 'Schlüssel kopiert. Die Zwischenablage wird nach 30 Sekunden geleert.';
    });
  }

  Future<void> _export() async {
    if (_exportKey == null || !_keySaved) return;
    final epoch = _epoch;
    final envelope = await widget.vault.createBackup(_exportKey!);
    if (!_current(epoch) || envelope == null) return;
    await widget.vault.saveBackupFile(envelope);
  }

  Future<void> _inspect() async {
    final archive = _archive;
    if (archive == null || _restoreKey.text.isEmpty) return;
    final epoch = _epoch;
    setState(() {
      _preview = null;
      _replaceExisting = false;
      _confirming = false;
    });
    final preview = await widget.vault.inspectBackup(archive, _restoreKey.text);
    if (!_current(epoch) || archive != _archive) return;
    setState(() => _preview = preview);
  }

  Future<void> _restore() async {
    final preview = _preview;
    final archive = _archive;
    if (preview == null || archive == null || !_confirming) return;
    final epoch = _epoch;
    await widget.vault.restoreBackup(
      archive,
      _restoreKey.text,
      preview,
      replaceExisting: _replaceExisting,
    );
    if (!_current(epoch)) return;
    setState(() {
      _preview = null;
      _replaceExisting = false;
      _confirming = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final busy = widget.vault.busy;
    final preview = _preview;
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Text('Sicherung', style: Theme.of(context).textTheme.headlineMedium),
        const SizedBox(height: 12),
        const Text(
          'Speichere eine verschlüsselte Datei für den Umzug oder die Wiederherstellung auf einem Mobilgerät. Bewahre den Schlüssel getrennt von der Datei auf.',
        ),
        const SizedBox(height: 24),
        Text(
          'Sicherung erstellen',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 12),
        const Text(
          'Ohne den Wiederherstellungsschlüssel kann die Datei nicht geöffnet werden. Er wird beim Sperren aus dieser Ansicht entfernt.',
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: busy ? null : _generateKey,
          icon: const Icon(Icons.key_outlined),
          label: Text(
            _exportKey == null
                ? 'Schlüssel erzeugen'
                : 'Neuen Schlüssel erzeugen',
          ),
        ),
        if (_exportKey != null) ...[
          const SizedBox(height: 12),
          Text(
            'Wiederherstellungsschlüssel',
            style: Theme.of(context).textTheme.labelLarge,
          ),
          const SizedBox(height: 8),
          Text(_exportKey!),
          TextButton.icon(
            onPressed: busy ? null : _copyKey,
            icon: const Icon(Icons.copy_outlined),
            label: const Text('Schlüssel geschützt kopieren'),
          ),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            title: const Text(
              'Ich habe den Schlüssel getrennt von der Sicherungsdatei gespeichert.',
            ),
            value: _keySaved,
            onChanged: busy
                ? null
                : (value) => setState(() => _keySaved = value ?? false),
          ),
          FilledButton.icon(
            onPressed: busy || !_keySaved ? null : _export,
            icon: const Icon(Icons.save_alt_outlined),
            label: const Text('Verschlüsselte Datei speichern'),
          ),
        ],
        if (_notice != null)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Semantics(liveRegion: true, child: Text(_notice!)),
          ),
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 24),
          child: Divider(),
        ),
        Text(
          'Sicherung wiederherstellen',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 12),
        const Text(
          'Die Dateiauswahl sperrt den Tresor. Entsperre ihn danach erneut und gib den zugehörigen Schlüssel ein. Die ausgewählte verschlüsselte Datei bleibt höchstens fünf Minuten verfügbar.',
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: busy
              ? null
              : () => unawaited(widget.vault.loadBackupFile()),
          icon: const Icon(Icons.folder_open_outlined),
          label: Text(
            _archive == null
                ? 'Sicherungsdatei auswählen'
                : 'Andere Sicherungsdatei auswählen',
          ),
        ),
        if (_archive != null) ...[
          const SizedBox(height: 12),
          const Text('Verschlüsselte Sicherung ausgewählt.'),
          const SizedBox(height: 12),
          TextField(
            controller: _restoreKey,
            maxLength: 128,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            enableIMEPersonalizedLearning: false,
            decoration: const InputDecoration(
              labelText: 'Wiederherstellungsschlüssel',
            ),
          ),
          OutlinedButton.icon(
            onPressed: busy || _restoreKey.text.isEmpty ? null : _inspect,
            icon: const Icon(Icons.preview_outlined),
            label: const Text('Vorschau prüfen'),
          ),
          TextButton(
            onPressed: busy ? null : widget.vault.clearBackupSelection,
            child: const Text('Ausgewählte Datei verwerfen'),
          ),
        ],
        if (preview != null) ...[
          const SizedBox(height: 12),
          Semantics(
            liveRegion: true,
            child: Text(
              '${preview.total} Logins: ${preview.newCount} neu, ${preview.existing} bereits vorhanden.',
            ),
          ),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: const Text('Enthaltene Logins ansehen'),
            children: [
              for (final entry in preview.entries)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(entry.title),
                  subtitle: Text('${entry.username}\n${entry.origin}'),
                  isThreeLine: true,
                ),
            ],
          ),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            title: const Text('Vorhandene Logins mit gleicher ID ersetzen'),
            subtitle: const Text(
              'Ohne Auswahl bleiben vorhandene Logins erhalten.',
            ),
            value: _replaceExisting,
            onChanged: busy
                ? null
                : (value) => setState(() {
                    _replaceExisting = value ?? false;
                    _confirming = false;
                  }),
          ),
          if (!_confirming)
            FilledButton(
              onPressed: busy ? null : () => setState(() => _confirming = true),
              child: const Text('Wiederherstellung vorbereiten'),
            )
          else ...[
            const SizedBox(height: 12),
            Text(
              _replaceExisting
                  ? '${preview.newCount} neue Logins hinzufügen und ${preview.existing} vorhandene Logins ersetzen?'
                  : '${preview.newCount} neue Logins hinzufügen? Vorhandene Logins bleiben erhalten.',
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: busy ? null : _restore,
              child: const Text('Wiederherstellung bestätigen'),
            ),
            TextButton(
              onPressed: busy
                  ? null
                  : () => setState(() => _confirming = false),
              child: const Text('Abbrechen'),
            ),
          ],
        ],
      ],
    );
  }
}
