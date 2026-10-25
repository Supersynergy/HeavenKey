import 'package:flutter/material.dart';

import 'mobile_theme.dart';
import 'vault_controller.dart';

class PasskeysPanel extends StatefulWidget {
  const PasskeysPanel({super.key, required this.vault});
  final VaultController vault;

  @override
  State<PasskeysPanel> createState() => _PasskeysPanelState();
}

class _PasskeysPanelState extends State<PasskeysPanel> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.vault.refreshConnections();
    });
  }

  @override
  Widget build(BuildContext context) {
    final vault = widget.vault;
    final supported = vault.status['passkeysSupported'] == true;
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(
          'Anmelden. Ohne Passwort.',
          style: Theme.of(context).textTheme.headlineMedium,
        ),
        const SizedBox(height: 16),
        VaultBanner(
          icon: Icons.fingerprint,
          title: 'Dein Handy ist dein Schlüssel',
          message: supported
              ? 'Wähle HeavenKey einmal als Passkey-Anbieter. Bei unterstützten Websites erstellst du danach einen Passkey und bestätigst Anmeldungen mit deiner Gerätesperre. Dein Desktop wird dafür nicht benötigt.'
              : 'HeavenKey als Website-Passkey-Anbieter benötigt Android 14 oder neuer. Deine gespeicherten Passwörter und Autofill kannst du weiterhin nutzen.',
          child: FilledButton.icon(
            onPressed: vault.busy || !supported ? null : vault.enablePasskeys,
            icon: const Icon(Icons.settings_outlined),
            label: const Text('Passkey-Anbieter einrichten'),
          ),
        ),
        const SizedBox(height: 24),
        Text(
          'Deine Website-Passkeys',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 12),
        if (vault.websitePasskeys.isEmpty)
          const VaultBanner(
            icon: Icons.add_moderator_outlined,
            title: 'Bereit für deinen ersten Passkey',
            message: 'Öffne die Sicherheitseinstellungen deines Website-Kontos und wähle „Passkey erstellen“. Wähle HeavenKey im Android-Dialog. Ein Passkey muss bei der Website registriert werden.',
          ),
        for (final key in vault.websitePasskeys) ...[
          Card(
            child: ListTile(
              leading: const Icon(Icons.fingerprint),
              title: Text('${key['rpId']}'),
              subtitle: Text('${key['userName']}'),
              trailing: IconButton(
                tooltip: 'Website-Passkey löschen',
                icon: const Icon(Icons.delete_outline),
                onPressed: vault.busy ? null : () => _delete(key),
              ),
            ),
          ),
          const SizedBox(height: 8),
        ],
        const SizedBox(height: 20),
        const Text(
          'Passkeys funktionieren nur bei Websites, die sie anbieten. Bestehende Website-Passwörter werden dadurch nicht automatisch ersetzt.',
        ),
      ],
    );
  }

  Future<void> _delete(Map<Object?, Object?> key) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Website-Passkey löschen?'),
        content: Text(
          'Der Passkey für ${key['rpId']} wird von diesem Handy entfernt. Stelle vorher sicher, dass du einen anderen Anmeldeweg hast. Die Registrierung bei der Website bleibt bestehen.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Behalten'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Löschen'),
          ),
        ],
      ),
    );
    if (confirmed == true && mounted && widget.vault.unlocked) {
      await widget.vault.deleteWebsitePasskey('${key['id']}');
    }
  }
}
