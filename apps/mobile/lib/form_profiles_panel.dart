import 'package:flutter/material.dart';

import 'form_profile.dart';
import 'vault_controller.dart';
import 'vault_entry.dart';

class FormProfilesPanel extends StatefulWidget {
  const FormProfilesPanel({super.key, required this.vault});
  final VaultController vault;
  @override
  State<FormProfilesPanel> createState() => _FormProfilesPanelState();
}

class _FormProfilesPanelState extends State<FormProfilesPanel> {
  Map<String, TextEditingController>? fields;
  String? id, error;

  void close() {
    for (final field in fields?.values ?? <TextEditingController>[]) {
      field.clear();
      field.dispose();
    }
    fields = null;
    id = null;
    error = null;
  }

  void edit([FormProfile? profile]) {
    close();
    setState(() {
      id = profile?.id ?? newEntryId();
      fields = {
        for (final name in FormProfile.labels.keys)
          name: TextEditingController(text: profile?.values[name] ?? ''),
      };
    });
  }

  @override
  void dispose() {
    close();
    super.dispose();
  }

  Future<void> save() async {
    try {
      final data = {
        for (final entry in fields!.entries) entry.key: entry.value.text.trim(),
        'id': id!,
        'updatedAt': DateTime.now().toUtc().toIso8601String(),
      };
      data['country'] = data['country']!.toUpperCase();
      if (data['fullName']!.isEmpty) {
        data['fullName'] = [
          data['givenName']!,
          data['familyName']!,
        ].where((value) => value.isNotEmpty).join(' ');
      }
      final profile = FormProfile(data);
      if (await widget.vault.saveProfile(profile) && mounted) setState(close);
    } on FormatException catch (failure) {
      if (mounted) setState(() => error = failure.message);
    }
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Text('Formularprofile', style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(height: 8),
      const Text(
        'Name, Kontakt und Adresse verschlüsselt speichern. Vor dem Ausfüllen wählst du ein Profil und die Felder aus. Formulare werden nicht automatisch abgesendet.',
      ),
      if (fields != null) ...[
        const SizedBox(height: 12),
        for (final entry in fields!.entries)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: TextField(
              key: ValueKey('profile-${entry.key}'),
              controller: entry.value,
              enabled: !widget.vault.busy,
              maxLength: FormProfile.limits[entry.key],
              enableIMEPersonalizedLearning: false,
              autocorrect: false,
              enableSuggestions: false,
              textInputAction: TextInputAction.next,
              keyboardType: switch (entry.key) {
                'email' => TextInputType.emailAddress,
                'phone' => TextInputType.phone,
                _ => TextInputType.text,
              },
              decoration: InputDecoration(
                labelText: FormProfile.labels[entry.key],
              ),
            ),
          ),
        if (error != null)
          Text(
            error!,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        Wrap(
          spacing: 8,
          children: [
            FilledButton(
              onPressed: widget.vault.busy ? null : save,
              child: const Text('Profil speichern'),
            ),
            TextButton(
              onPressed: widget.vault.busy ? null : () => setState(close),
              child: const Text('Abbrechen'),
            ),
          ],
        ),
      ] else ...[
        for (final profile in widget.vault.profiles)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.contact_page_outlined),
            title: Text(profile.label),
            onTap: widget.vault.busy ? null : () => edit(profile),
            trailing: IconButton(
              tooltip: 'Profil löschen',
              icon: const Icon(Icons.delete_outline),
              onPressed: widget.vault.busy
                  ? null
                  : () async {
                      final accepted = await showDialog<bool>(
                        context: context,
                        builder: (context) => AlertDialog(
                          title: const Text('Formularprofil löschen?'),
                          content: Text(profile.label),
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
                      if (accepted == true &&
                          mounted &&
                          widget.vault.unlocked) {
                        await widget.vault.deleteProfile(profile.id);
                      }
                    },
            ),
          ),
        OutlinedButton.icon(
          onPressed: widget.vault.busy || widget.vault.profiles.length >= 100
              ? null
              : () => edit(),
          icon: const Icon(Icons.add),
          label: const Text('Formularprofil hinzufügen'),
        ),
      ],
      const SizedBox(height: 24),
      Text(
        'Freigegebene Android-Apps',
        style: Theme.of(context).textTheme.titleLarge,
      ),
      const SizedBox(height: 8),
      const Text(
        'Beim ersten Ausfüllen ordnest du einen Login ausdrücklich der App zu. HeavenKey prüft danach Paketname und Signatur erneut. Auf einem neuen Gerät werden App-Freigaben erneut erteilt.',
      ),
      if (widget.vault.appBindings.isEmpty)
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 12),
          child: Text('Noch keine App-Freigaben.'),
        ),
      for (final package
          in widget.vault.appBindings
              .map((binding) => binding['packageName']!)
              .toSet())
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(package),
          subtitle: Text(
            '${widget.vault.appBindings.where((binding) => binding['packageName'] == package).length} zugeordnete Logins',
          ),
          trailing: TextButton(
            onPressed: widget.vault.busy
                ? null
                : () => widget.vault.revokeApp(package),
            child: const Text('Widerrufen'),
          ),
        ),
    ],
  );
}
