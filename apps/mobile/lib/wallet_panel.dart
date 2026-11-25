import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

const walletChannel = MethodChannel('heavenkey/wallet');

class WalletPanel extends StatefulWidget {
  const WalletPanel({
    super.key,
    required this.pending,
    required this.onPendingChanged,
  });

  final bool pending;
  final Future<void> Function() onPendingChanged;

  @override
  State<WalletPanel> createState() => _WalletPanelState();
}

enum _WalletPurpose {
  issue('issuance', 'Mitgliedschaft speichern', 'Nachweis speichern'),
  access('project.access', 'Zugang zum Projekt', 'Angaben übermitteln'),
  invoice(
    'invoice.draft.create',
    'Einmalig einen Rechnungsentwurf erlauben',
    'Auftrag freigeben',
  );

  const _WalletPurpose(this.id, this.title, this.confirmation);
  final String id;
  final String title;
  final String confirmation;

  static _WalletPurpose parse(Object? value) => values.firstWhere(
    (purpose) => purpose.id == value,
    orElse: () => throw const FormatException('Unbekannter Zweck'),
  );
}

class _WalletPreview {
  _WalletPreview(Map<Object?, Object?> data)
    : id = _requiredText(data, 'id'),
      fingerprint = _requiredText(data, 'fingerprint'),
      purpose = _WalletPurpose.parse(data['kind']),
      recipient = _requiredText(data, 'recipient'),
      target = _requiredText(data, 'target'),
      expiresAt = _requiredDate(data, 'expires_at'),
      claims = Map.unmodifiable(_requiredMap(data, 'claims')),
      operation = Map.unmodifiable(_requiredMap(data, 'operation')) {
    if (purpose != _WalletPurpose.issue) {
      _requireKnownKeys(claims, {'org_id', 'membership'});
      _requiredText(claims, 'org_id');
      _requiredText(claims, 'membership');
      _requiredText(operation, 'tenant');
      _requiredText(operation, 'resource');
    } else {
      _requireKnownKeys(claims, {});
    }
    final allowed = switch (purpose) {
      _WalletPurpose.issue => <String>{},
      _WalletPurpose.access => {'kind', 'tenant', 'resource'},
      _WalletPurpose.invoice => {
        'kind',
        'tenant',
        'resource',
        'agent_id',
        'amount_minor',
        'currency',
        'uses',
        'expiration',
      },
    };
    _requireKnownKeys(operation, allowed);
    if (operation.containsKey('kind') && operation['kind'] != purpose.id) {
      throw const FormatException('Abweichender Zweck');
    }
    if (purpose == _WalletPurpose.invoice) {
      _requiredText(operation, 'agent_id');
      _requiredDate(operation, 'expiration');
      final amount = operation['amount_minor'];
      if (amount is! int ||
          amount <= 0 ||
          operation['currency'] != 'EUR' ||
          operation['uses'] != 1) {
        throw const FormatException('Ungültiger Auftragsumfang');
      }
    }
  }

  final String id;
  final String fingerprint;
  final _WalletPurpose purpose;
  final String recipient;
  final String target;
  final DateTime expiresAt;
  final Map<Object?, Object?> claims;
  final Map<Object?, Object?> operation;

  Map<String, String> get confirmation => {
    'id': id,
    'fingerprint': fingerprint,
  };
}

class _Membership {
  _Membership(Map<Object?, Object?> data)
    : issuer = _requiredText(data, 'issuer'),
      organization = _requiredText(data, 'org_id'),
      membership = _requiredText(data, 'membership'),
      expiresAt = _requiredDate(data, 'expires_at'),
      status = _requiredText(data, 'status');

  final String issuer;
  final String organization;
  final String membership;
  final DateTime expiresAt;
  final String status;

  String get statusLabel => switch (status) {
    'valid' || 'active' || 'good' => 'Gültig laut letzter Prüfung',
    'revoked' => 'Widerrufen',
    'suspended' => 'Ausgesetzt',
    'expired' => 'Abgelaufen',
    'key_lost' => 'Geräteschlüssel fehlt. Neuausstellung erforderlich.',
    _ => 'Status derzeit ungeprüft',
  };
}

class _WalletOutcome {
  _WalletOutcome(Map<Object?, Object?> data, {_WalletPurpose? fallback})
    : status = _requiredText(data, 'status'),
      actionStatus = switch (data['action_status']) {
        final String value => value,
        _ => null,
      },
      id = data['id'] as String?,
      purpose = data['kind'] == null
          ? fallback
          : _WalletPurpose.parse(data['kind']);

  final String status;
  final String? actionStatus;
  final String? id;
  final _WalletPurpose? purpose;

  String? get code => id == null ? null : _requestCode(id!);

  String get label => switch (status) {
    'issued' => 'Mitgliedschaftsnachweis auf diesem Gerät gespeichert.',
    'verified' when purpose == _WalletPurpose.invoice => switch (actionStatus) {
      'approved' => 'Nachweis geprüft, Auftrag einmalig freigegeben. Für einen Widerruf öffne den ursprünglichen Browservorgang.',
      'executed' => 'Zielanwendung hat den Rechnungsentwurf erstellt.',
      'revoked' => 'Agentenfreigabe widerrufen.',
      'expired' => 'Agentenfreigabe abgelaufen.',
      _ => 'Empfänger hat den Nachweis geprüft. Prüfe den Auftrag in der ursprünglichen Browsersitzung.',
    },
    'verified' => 'Empfänger hat den Nachweis geprüft. Prüfe den Projektzugang in der ursprünglichen Browsersitzung.',
    'transferred' => 'Übertragung bestätigt. Die Prüfung steht noch aus.',
    'expired' => 'Vorgang abgelaufen.',
    'cancelled' => 'Vorgang abgebrochen.',
    'denied' || 'rejected' => 'Empfänger hat die Anfrage abgelehnt.',
    'pending' => 'Bestätigung der Zielanwendung steht noch aus.',
    _ => 'Ausgang unklar. Prüfe den Vorgang vor einer neuen Freigabe.',
  };
}

class _WalletPanelState extends State<WalletPanel> {
  bool busy = false;
  bool ayaEnabled = false;
  String? message;
  _WalletPreview? plan;
  List<_Membership> memberships = [];
  _WalletOutcome? outcome;
  List<_WalletOutcome> earlierOutcomes = [];

  @override
  void initState() {
    super.initState();
    unawaited(_run(_refresh));
  }

  Future<void> _run(
    Future<void> Function() task, {
    bool clearPreviewOnError = false,
  }) async {
    if (busy) return;
    setState(() {
      busy = true;
      message = null;
    });
    try {
      await task();
    } on PlatformException catch (failure) {
      if (!mounted) return;
      if (clearPreviewOnError) plan = null;
      unawaited(widget.onPendingChanged());
      message = switch (failure.code) {
        'cancelled' || 'wallet_auth_cancelled' =>
          'Gerätebestätigung abgebrochen. Öffne eine neue Vorschau.',
        'locked' ||
        'wallet_locked' => 'Entsperre HeavenKey erneut und prüfe den Vorgang.',
        'expired' || 'wallet_expired' =>
          'Anfrage abgelaufen. Starte eine neue Anfrage im Browser.',
        'wallet_changed' =>
          'Die Anfrage hat sich geändert. Prüfe die neue Vorschau.',
        'wallet_no_valid_credential' => 'Kein gültiger Mitgliedschaftsnachweis verfügbar. Prüfe deine Nachweise oder öffne eine Testeinladung.',
        'wallet_key_lost' => 'Der Geräteschlüssel fehlt. Für den Nachweis ist eine Neuausstellung erforderlich.',
        'wallet_unreachable' => 'Der Testdienst ist nicht erreichbar. Prüfe die Verbindung und den Vorgangsstatus.',
        'untrusted_signature' =>
          'Die Angaben des Dienstes konnten nicht überprüft werden.',
        _ => 'Aktion konnte nicht bestätigt werden. Prüfe den Vorgangsstatus.',
      };
    } on MissingPluginException {
      if (mounted) message = 'Nachweise sind in diesem Build nicht verfügbar.';
    } on FormatException {
      if (!mounted) return;
      plan = null;
      message = 'Die Anfrage kann nicht vollständig angezeigt werden.';
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _refresh() async {
    final status = await walletChannel.invokeMapMethod<Object?, Object?>(
      'status',
      {'include_aya': true},
    );
    if (!mounted) return;
    final records = await walletChannel.invokeListMethod<Object?>('list') ?? [];
    if (!mounted) return;
    ayaEnabled = status?['aya_enabled'] == true;
    memberships = records
        .map((record) {
          if (record is! Map<Object?, Object?>) {
            throw const FormatException('Ungültige Nachweisübersicht');
          }
          return _Membership(record);
        })
        .toList(growable: false);
    await _refreshOutcome();
    if (mounted) await _loadActivity();
  }

  Future<void> _refreshOutcome() async {
    final data = await walletChannel.invokeMapMethod<Object?, Object?>(
      'getRequestStatus',
    );
    if (mounted && data != null) {
      outcome = _WalletOutcome(data, fallback: outcome?.purpose);
    }
  }

  Future<void> _loadActivity() async {
    final records =
        await walletChannel.invokeListMethod<Object?>('activity') ?? [];
    if (!mounted) return;
    earlierOutcomes = [
      for (final record in records)
        if (record is Map<Object?, Object?> && record['id'] != outcome?.id)
          _WalletOutcome(record),
    ];
  }

  Future<void> _reconcile(_WalletOutcome receipt) async {
    await walletChannel.invokeMapMethod<Object?, Object?>('getRequestStatus', {
      'id': receipt.id,
    });
    if (mounted) await _loadActivity();
  }

  Future<void> _prepare() async {
    final data = await walletChannel.invokeMapMethod<Object?, Object?>(
      'prepare',
    );
    if (!mounted) return;
    if (data == null) {
      message = 'Es liegt keine offene Anfrage vor.';
      await widget.onPendingChanged();
      return;
    }
    plan = _WalletPreview(data);
  }

  Future<void> _pasteLink() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    if (!mounted) return;
    final link = data?.text?.trim();
    if (link == null || link.isEmpty || link.length > 2048) {
      message = 'Kopiere zuerst den Einladungslink aus dem Systembrowser.';
      return;
    }
    await walletChannel.invokeMethod<void>('enqueue', {'uri': link});
    if (!mounted) return;
    await widget.onPendingChanged();
    if (mounted) await _prepare();
  }

  Future<void> _approve(_WalletPreview displayedPlan) async {
    plan = null;
    final data = await walletChannel.invokeMapMethod<Object?, Object?>(
      'approve',
      displayedPlan.confirmation,
    );
    if (!mounted) return;
    if (data == null) throw const FormatException('Vorgang ohne Ergebnis');
    outcome = _WalletOutcome(data, fallback: displayedPlan.purpose);
    await widget.onPendingChanged();
    if (!mounted) return;
    if (outcome?.status == 'issued') {
      await _refresh();
    } else {
      await _loadActivity();
    }
  }

  Future<void> _cancel(_WalletPreview displayedPlan) async {
    await walletChannel.invokeMethod<void>(
      'cancel',
      displayedPlan.confirmation,
    );
    if (!mounted) return;
    plan = null;
    message = 'Anfrage abgebrochen.';
    await widget.onPendingChanged();
  }

  Future<void> _setAya(bool enabled) async {
    await walletChannel.invokeMethod<void>('setAya', {'enabled': enabled});
    if (mounted) ayaEnabled = enabled;
  }

  @override
  Widget build(BuildContext context) {
    final displayedPlan = plan;
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const Text('Testprofil für synthetische Mitgliedschaftsnachweise'),
        if (busy)
          const LinearProgressIndicator(
            semanticsLabel: 'Nachweisvorgang läuft',
          ),
        if (message != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Semantics(liveRegion: true, child: Text(message!)),
          ),
        if (displayedPlan != null) ...[
          const SizedBox(height: 12),
          _ConsentCard(
            plan: displayedPlan,
            approve: busy ? null : () => _run(() => _approve(displayedPlan)),
            cancel: busy
                ? null
                : () => _run(
                    () => _cancel(displayedPlan),
                    clearPreviewOnError: true,
                  ),
          ),
        ] else ...[
          const SizedBox(height: 12),
          if (widget.pending)
            FilledButton.icon(
              onPressed: busy ? null : () => _run(_prepare),
              icon: const Icon(Icons.fact_check_outlined),
              label: const Text('Offene Anfrage prüfen'),
            ),
          OutlinedButton.icon(
            onPressed: busy ? null : () => _run(_pasteLink),
            icon: const Icon(Icons.content_paste),
            label: const Text('Link aus Zwischenablage öffnen'),
          ),
        ],
        if (outcome case final outcome?) ...[
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    outcome.code == null
                        ? 'Letzter Vorgang'
                        : 'Letzter Vorgang · ${outcome.code}',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 4),
                  Semantics(liveRegion: true, child: Text(outcome.label)),
                  TextButton(
                    onPressed: busy ? null : () => _run(_refresh),
                    child: const Text('Vorgangsstatus prüfen'),
                  ),
                ],
              ),
            ),
          ),
        ] else
          TextButton(
            onPressed: busy ? null : () => _run(_refresh),
            child: const Text('Nachweise und Status neu laden'),
          ),
        if (earlierOutcomes.isNotEmpty)
          ExpansionTile(
            title: const Text('Frühere Vorgänge'),
            children: [
              for (final receipt in earlierOutcomes)
                ListTile(
                  title: Text(
                    '${receipt.purpose?.title ?? 'Vorgang'} · ${receipt.code ?? ''}',
                  ),
                  subtitle: Text(receipt.label),
                  trailing: IconButton(
                    tooltip: 'Status dieses Vorgangs prüfen',
                    icon: const Icon(Icons.refresh),
                    onPressed: busy || receipt.id == null
                        ? null
                        : () => _run(() => _reconcile(receipt)),
                  ),
                ),
            ],
          ),
        const SizedBox(height: 16),
        Text('Mitgliedschaften', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 8),
        if (memberships.isEmpty && !busy)
          const Text(
            'Öffne eine Testeinladung, um einen Nachweis zu speichern.',
          ),
        for (final membership in memberships)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    membership.organization,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  Text(_claimValue('membership', membership.membership)),
                  Text('Testaussteller: ${membership.issuer}'),
                  Text('Gültig bis ${_dateLabel(membership.expiresAt)}'),
                  Text(membership.statusLabel),
                ],
              ),
            ),
          ),
        const SizedBox(height: 16),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: ayaEnabled,
          onChanged: busy ? null : (enabled) => _run(() => _setAya(enabled)),
          title: const Text('AYA-Profil anzeigen'),
          subtitle: Text(
            ayaEnabled
                ? 'AYA ID und CONNECT · Testprofil für Mitgliedschaft und Freigaben.'
                : 'Optionale Darstellung für Mitgliedschaft und Freigaben.',
          ),
        ),
        const Text(
          'Diese Nachweise bleiben auf diesem Gerät. Bei Geräteverlust oder Schlüsseltausch ist eine Neuausstellung erforderlich.',
        ),
      ],
    );
  }
}

class _ConsentCard extends StatelessWidget {
  const _ConsentCard({
    required this.plan,
    required this.approve,
    required this.cancel,
  });

  final _WalletPreview plan;
  final VoidCallback? approve;
  final VoidCallback? cancel;

  @override
  Widget build(BuildContext context) {
    final purpose = plan.purpose;
    final operation = plan.operation;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(purpose.title, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            Text(
              purpose == _WalletPurpose.issue
                  ? 'Testaussteller: ${plan.recipient}'
                  : 'Geprüfter Empfänger: ${plan.recipient}',
            ),
            Text('Übertragung an ${plan.target}'),
            Text('Anfrage gültig bis ${_dateLabel(plan.expiresAt)}'),
            const SizedBox(height: 12),
            if (purpose == _WalletPurpose.issue)
              const Text('Nachweistyp: Organisationsmitgliedschaft')
            else ...[
              Text('Vorgang ${_requestCode(plan.id)}'),
              const Text('Gleiche den Vorgang mit dem Browser ab.'),
              Text('Organisation: ${plan.claims['org_id']}'),
              Text(
                'Mitgliedschaft: ${_claimValue('membership', plan.claims['membership'] as String)}',
              ),
              Text('Mandant: ${operation['tenant']}'),
              Text(
                purpose == _WalletPurpose.invoice
                    ? 'Auftrag: ${operation['resource']}'
                    : 'Projekt: ${operation['resource']}',
              ),
            ],
            if (purpose == _WalletPurpose.invoice) ...[
              const SizedBox(height: 12),
              Text('Agent: ${operation['agent_id']}'),
              Text('Entwurfsbetrag: ${_amountLabel(operation)}'),
              Text(
                'Einmal verwendbar bis ${_dateLabel(_requiredDate(operation, 'expiration'))}',
              ),
              const Text(
                'Die Freigabe erlaubt ausschließlich einen Entwurf. Versand und Zahlung benötigen einen eigenen Vorgang.',
              ),
            ],
            const SizedBox(height: 16),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton(
                  onPressed: approve,
                  child: Text(purpose.confirmation),
                ),
                TextButton(onPressed: cancel, child: const Text('Abbrechen')),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

String _requiredText(Map<Object?, Object?> data, String key) {
  final value = data[key];
  if (value is! String || value.isEmpty || value.length > 2048) {
    throw const FormatException('Ungültige Anzeigeangabe');
  }
  return value;
}

DateTime _requiredDate(Map<Object?, Object?> data, String key) {
  final value = data[key];
  if (value is! int || value <= 0 || value > 4102444800) {
    throw const FormatException('Ungültige Gültigkeitsfrist');
  }
  return DateTime.fromMillisecondsSinceEpoch(value * 1000);
}

Map<Object?, Object?> _requiredMap(Map<Object?, Object?> data, String key) {
  final value = data[key];
  if (value is! Map<Object?, Object?>) {
    throw const FormatException('Ungültige Vorschau');
  }
  return value;
}

void _requireKnownKeys(Map<Object?, Object?> data, Set<String> allowed) {
  if (data.keys.any((key) => !allowed.contains(key))) {
    throw const FormatException('Unvollständige Vorschau');
  }
}

String _dateLabel(DateTime date) {
  String padded(int value) => value.toString().padLeft(2, '0');
  return '${padded(date.day)}.${padded(date.month)}.${date.year} · '
      '${padded(date.hour)}:${padded(date.minute)}';
}

String _requestCode(String id) =>
    id.length <= 6 ? id : id.substring(id.length - 6);

String _claimValue(String claim, String value) =>
    claim == 'membership' && value == 'project-member'
    ? 'Projektmitglied (project-member)'
    : value;

String _amountLabel(Map<Object?, Object?> operation) {
  final minor = operation['amount_minor'] as int;
  return '${minor ~/ 100},${(minor % 100).toString().padLeft(2, '0')} ${operation['currency']}';
}
