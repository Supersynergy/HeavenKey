import 'package:flutter/material.dart';

import 'vault_controller.dart';

class ConnectedPanel extends StatefulWidget {
  const ConnectedPanel({super.key, required this.vault});
  final VaultController vault;
  @override
  State<ConnectedPanel> createState() => _ConnectedPanelState();
}

class _ConnectedPanelState extends State<ConnectedPanel> {
  final code = TextEditingController();
  @override
  void initState() {
    super.initState();
    widget.vault.addListener(changed);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.vault.refreshConnections();
    });
  }

  void changed() {
    if (!widget.vault.unlocked) code.clear();
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.vault.removeListener(changed);
    code.clear();
    code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final vault = widget.vault;
    final connected = vault.connection['connected'] == true;
    final conflict = vault.connection['conflict'];
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Text(
          'Desktop verbinden',
          style: Theme.of(context).textTheme.headlineMedium,
        ),
        const SizedBox(height: 16),
        const Text(
          'Öffne am Desktop die Einstellungen „Handy synchronisieren“. Beide Geräte müssen den angegebenen Computer erreichen können. Kopiere den einmaligen Code hierher; er enthält den geheimen Schlüssel.',
        ),
        const SizedBox(height: 16),
        if (!connected) ...[
          TextField(
            controller: code,
            minLines: 2,
            maxLines: 5,
            obscureText: false,
            autocorrect: false,
            enableSuggestions: false,
            enableIMEPersonalizedLearning: false,
            decoration: const InputDecoration(
              labelText: 'Einmaliger Kopplungscode',
            ),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: vault.busy
                ? null
                : () async {
                    final value = code.text.trim();
                    code.clear();
                    await vault.synchronize(code: value);
                    if (vault.unlocked) await vault.refreshConnections();
                  },
            child: const Text('Desktop koppeln und synchronisieren'),
          ),
        ] else ...[
          Text(
            vault.connection['pending'] == true
                ? 'Kopplung noch nicht abgeschlossen: ${vault.connection['endpoint']}. Erneut synchronisieren oder die lokale Verbindung entfernen.'
                : 'Verbunden mit ${vault.connection['endpoint']}',
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: vault.busy
                ? null
                : () async {
                    await vault.synchronize();
                    if (vault.unlocked) await vault.refreshConnections();
                  },
            child: const Text('Jetzt synchronisieren'),
          ),
          if (conflict is Map && conflict['token'] is String) ...[
            const Text(
              'Widersprüchliche Änderungen. Die Auswahl betrifft nur diese Einträge; andere Änderungen werden zusammengeführt.',
            ),
            if (conflict['entries'] is List)
              for (final row in conflict['entries'] as List)
                if (row is Map) Text('${row['title']}'),
            for (final side in ['remote', 'local'])
              OutlinedButton(
                onPressed: vault.busy
                    ? null
                    : () async {
                        final label = side == 'remote'
                            ? 'Desktop-Stand'
                            : 'Stand dieses Geräts';
                        final confirmed = await showDialog<bool>(
                          context: context,
                          builder: (context) => AlertDialog(
                            title: Text('$label übernehmen?'),
                            content: const Text(
                              'Die widersprüchlichen Einträge werden ausdrücklich durch den gewählten Stand ersetzt. Wurde zwischenzeitlich weitergearbeitet, musst du erneut prüfen.',
                            ),
                            actions: [
                              TextButton(
                                onPressed: () => Navigator.pop(context, false),
                                child: const Text('Abbrechen'),
                              ),
                              TextButton(
                                onPressed: () => Navigator.pop(context, true),
                                child: const Text('Stand übernehmen'),
                              ),
                            ],
                          ),
                        );
                        if (confirmed == true) {
                          await vault.synchronize(
                            resolution: side,
                            conflictToken: '${conflict['token']}',
                          );
                          if (vault.unlocked) await vault.refreshConnections();
                        }
                      },
                child: Text(
                  side == 'remote'
                      ? 'Desktop-Stand wählen'
                      : 'Diesen Gerätestand wählen',
                ),
              ),
          ],
          TextButton(
            onPressed: vault.busy
                ? null
                : () async {
                    final confirmed = await showDialog<bool>(
                      context: context,
                      builder: (context) => AlertDialog(
                        title: const Text('Verbindung lokal entfernen?'),
                        content: const Text(
                          'Logins und Passkeys bleiben auf diesem Gerät erhalten. Widerrufe die Verbindung zusätzlich in den Desktop-Einstellungen.',
                        ),
                        actions: [
                          TextButton(
                            onPressed: () => Navigator.pop(context, false),
                            child: const Text('Behalten'),
                          ),
                          TextButton(
                            onPressed: () => Navigator.pop(context, true),
                            child: const Text('Verbindung entfernen'),
                          ),
                        ],
                      ),
                    );
                    if (confirmed == true) await vault.disconnectDesktop();
                  },
            child: const Text('Verbindung lokal entfernen'),
          ),
        ],
        const SizedBox(height: 24),
        const Text(
          'Synchronisiere auch am Desktop, damit er Änderungen vom Handy übernimmt. Gleichzeitige Änderungen desselben Eintrags werden als Konflikt angezeigt. Es gibt kein stilles Überschreiben.',
        ),
        const SizedBox(height: 24),
        Text(
          'Website-Passkeys',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 12),
        const Text(
          'Android 14 oder neuer: Wähle HeavenKey als Passkey-Anbieter. Neue Passkeys entstehen beim Registrieren auf einer Website und werden erst nach deiner Freigabe verwendet. Danach kannst du sie mit dem Desktop synchronisieren.',
        ),
        FilledButton(
          onPressed: vault.busy ? null : () => vault.enablePasskeys(),
          child: const Text('Passkey-Anbieter einrichten'),
        ),
        for (final key in vault.websitePasskeys)
          ListTile(
            title: Text('${key['rpId']}'),
            subtitle: Text('${key['userName']}'),
            trailing: IconButton(
              tooltip: 'Website-Passkey löschen',
              icon: const Icon(Icons.delete_outline),
              onPressed: vault.busy
                  ? null
                  : () async {
                      final confirmed = await showDialog<bool>(
                        context: context,
                        builder: (context) => AlertDialog(
                          title: const Text('Website-Passkey löschen?'),
                          content: const Text(
                            'Die Registrierung bei der Website bleibt bestehen. Synchronisiere danach die verbundenen Geräte.',
                          ),
                          actions: [
                            TextButton(
                              onPressed: () => Navigator.pop(context, false),
                              child: const Text('Behalten'),
                            ),
                            TextButton(
                              onPressed: () => Navigator.pop(context, true),
                              child: const Text('Löschen'),
                            ),
                          ],
                        ),
                      );
                      if (confirmed == true) {
                        await vault.deleteWebsitePasskey('${key['id']}');
                      }
                    },
            ),
          ),
        if (vault.websitePasskeys.isEmpty)
          const Text('Noch keine Website-Passkeys auf diesem Gerät.'),
      ],
    );
  }
}
