// ---------------------------------------------------------------------------
// App.js
// ---------------------------------------------------------------------------
// Single screen to edit four localized App Store fields:
//   * Promotional Text (≤170)
//   * Keywords         (≤100, comma-separated)
//   * Description      (≤4000)
//   * What's New       (≤4000)
//
// You type once (any language). The backend translates each field into every
// open locale's language and pushes them to the EDITABLE version (Waiting for
// Review / Prepare for Submission) — Apple won't accept description/keywords/
// whatsNew on a live "Ready for Sale" version.
//
// The app never talks to Apple or OpenAI directly — only to our backend.
// ---------------------------------------------------------------------------

import React, {useEffect, useState} from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import config from './config';

// App Store Connect locale code -> human-readable name (Apple's own labels).
const LOCALE_NAMES = {
  'ar-SA': 'Arabic',
  ca: 'Catalan',
  cs: 'Czech',
  da: 'Danish',
  'de-DE': 'German',
  el: 'Greek',
  'en-AU': 'English (Australia)',
  'en-CA': 'English (Canada)',
  'en-GB': 'English (U.K.)',
  'en-US': 'English (U.S.)',
  'es-ES': 'Spanish (Spain)',
  'es-MX': 'Spanish (Mexico)',
  fi: 'Finnish',
  'fr-CA': 'French (Canada)',
  'fr-FR': 'French',
  he: 'Hebrew',
  hi: 'Hindi',
  hr: 'Croatian',
  hu: 'Hungarian',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  ms: 'Malay',
  'nl-NL': 'Dutch',
  no: 'Norwegian',
  pl: 'Polish',
  'pt-BR': 'Portuguese (Brazil)',
  'pt-PT': 'Portuguese (Portugal)',
  ro: 'Romanian',
  ru: 'Russian',
  sk: 'Slovak',
  'sl-SI': 'Slovenian',
  sv: 'Swedish',
  th: 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
  vi: 'Vietnamese',
  'zh-Hans': 'Chinese (Simplified)',
  'zh-Hant': 'Chinese (Traditional)',
  'bn-BD': 'Bengali',
  'gu-IN': 'Gujarati',
  'kn-IN': 'Kannada',
  'ml-IN': 'Malayalam',
  'mr-IN': 'Marathi',
  'or-IN': 'Odia',
  'pa-IN': 'Punjabi',
  'ta-IN': 'Tamil',
  'te-IN': 'Telugu',
  'ur-PK': 'Urdu',
};

// "English (Canada) · en-CA" — full name plus the code so it stays unambiguous.
// Falls back to the raw code for anything not in the map.
function localeLabel(code) {
  const name = LOCALE_NAMES[code];
  return name ? `${name} · ${code}` : code;
}

// Tiny checkbox (RN core has none). A box that shows ✓ when on.
function Checkbox({label, value, onValueChange, disabled}) {
  return (
    <TouchableOpacity
      style={styles.cb}
      onPress={() => !disabled && onValueChange(!value)}
      disabled={disabled}
      activeOpacity={0.6}>
      <View
        style={[
          styles.cbBox,
          value && styles.cbBoxOn,
          disabled && styles.cbBoxDisabled,
        ]}>
        {value ? <Text style={styles.cbCheck}>✓</Text> : null}
      </View>
      <Text style={[styles.cbLabel, disabled && styles.cbLabelDisabled]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// A real, filled button (RN's core <Button> renders as plain blue text on iOS,
// which reads like a link). `variant="secondary"` is the outlined style used for
// low-emphasis actions like Reload.
function AppButton({title, onPress, disabled, variant = 'primary'}) {
  const secondary = variant === 'secondary';
  return (
    <TouchableOpacity
      style={[
        styles.btn,
        secondary ? styles.btnSecondary : styles.btnPrimary,
        disabled && styles.btnDisabled,
      ]}
      onPress={() => !disabled && onPress && onPress()}
      disabled={disabled}
      activeOpacity={0.7}>
      <Text
        style={[
          styles.btnText,
          secondary ? styles.btnTextSecondary : styles.btnTextPrimary,
          disabled && styles.btnTextDisabled,
        ]}>
        {title}
      </Text>
    </TouchableOpacity>
  );
}

// Ukrainian duplicate of a status message. Returns the UA text, or null when
// there's no known mapping (then we just don't show a second line). Handles the
// dynamic messages (version banner, char-limit, network error) with regexes.
function toUkrainian(msg) {
  if (!msg) return null;

  let m;
  m = msg.match(/^Editable version (.+) \((.+)\)\. Locales: (.+)$/);
  if (m) return `Редагована версія ${m[1]} (${m[2]}). Локалі: ${m[3]}`;
  m = msg.match(/^Network error: (.+)$/);
  if (m) return `Помилка мережі: ${m[1]}`;
  m = msg.match(/^Pushed (.+) to all locales\.$/);
  if (m) return `Запушено ${m[1]} в усі локалі.`;
  m = msg.match(/^"(.+)" must be (\d+) characters or fewer\.$/);
  if (m) return `«${m[1]}» має бути не більше ${m[2]} символів.`;

  const map = {
    'Finding editable version...': 'Шукаю редаговану версію...',
    'No editable version.': 'Немає редагованої версії.',
    'Translating all fields into every locale and pushing...':
      'Перекладаю всі поля на кожну локаль і пушу...',
    'Some locales failed — see details below.':
      'Частина локалей не вдалася — деталі нижче.',
    'Push failed.': 'Не вдалося запушити.',
    "No editable version found. Description / Keywords / What's New can only be edited on a version in an editable state (e.g. Waiting for Review or Prepare for Submission). Create or submit a new version in App Store Connect first.":
      "Редаговану версію не знайдено. Description / Keywords / What's New можна редагувати лише на версії в редагованому стані (напр. Waiting for Review або Prepare for Submission). Спершу створіть або подайте нову версію в App Store Connect.",
    'No editable version (Waiting for Review / Prepare for Submission). Create or submit a new version in App Store Connect first.':
      'Немає редагованої версії (Waiting for Review / Prepare for Submission). Спершу створіть або подайте нову версію в App Store Connect.',
    'Provide at least one of: promotionalText, description, keywords, whatsNew.':
      'Вкажіть хоча б одне поле: promotionalText, description, keywords, whatsNew.',
    'The editable version has no localizations.':
      'Редагована версія не має локалізацій.',
    'Unauthorized — JWT is missing, expired, or invalid.':
      'Неавторизовано — JWT відсутній, прострочений або недійсний.',
    'Forbidden — the API key lacks permission for this resource.':
      'Заборонено — ключу API бракує прав на цей ресурс.',
    'Not Found — check your APP_STORE_VERSION_ID / LOCALIZATION_ID.':
      'Не знайдено — перевірте APP_STORE_VERSION_ID / LOCALIZATION_ID.',
    'Conflict — the version state does not allow this edit (e.g. not editable).':
      'Конфлікт — стан версії не дозволяє це редагування (напр. не редагована).',
    'Unprocessable Entity — the value was rejected (too long / invalid).':
      'Неприйнятні дані — значення відхилено (задовге / недійсне).',
    'Network error — could not reach App Store Connect API.':
      'Помилка мережі — не вдалося звʼязатися з App Store Connect API.',
    'App Store Connect API error.': 'Помилка App Store Connect API.',
  };
  return map[msg] || null;
}

// Field metadata: key, label, Apple limit, big = tall multiline box.
const FIELDS = [
  {key: 'promotionalText', label: 'Promotional Text', max: 170, big: false},
  {key: 'keywords', label: 'Keywords (comma-separated)', max: 100, big: false},
  {key: 'description', label: 'Description', max: 4000, big: true},
  {key: 'whatsNew', label: "What's New in This Version", max: 4000, big: true},
  {
    key: 'supportUrl',
    label: 'Support URL',
    max: 255,
    big: false,
    url: true,
    note: 'Not translated — pushed as-is to every locale.',
  },
  {
    key: 'privacyPolicyUrl',
    label: 'Privacy Policy URL',
    max: 255,
    big: false,
    url: true,
    note: 'App Information — pushed as-is to every locale (not translated).',
  },
];

// A tab button in the top bar.
function TabButton({label, active, onPress}) {
  return (
    <TouchableOpacity
      style={[styles.tabBtn, active && styles.tabBtnActive]}
      onPress={onPress}
      activeOpacity={0.7}>
      <Text style={[styles.tabBtnText, active && styles.tabBtnTextActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Screenshots tab — pick locales, submit the folder's screenshots to them.
// ---------------------------------------------------------------------------
function ScreenshotsTab({api}) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState({}); // locale -> bool
  const [replace, setReplace] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [statusCode, setStatusCode] = useState(null);
  const [statusLine, setStatusLine] = useState('');
  const [isError, setIsError] = useState(false);
  const [results, setResults] = useState([]);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setStatusLine('Loading screenshots + locales...');
    setIsError(false);
    setResults([]);
    try {
      const res = await api('/screenshots');
      const json = await res.json();
      setStatusCode(res.status);
      setData(json);
      if (res.ok && json.ok) {
        setStatusLine(
          `Editable version ${json.version.versionString}. ` +
            `${(json.screenshots || []).length} file(s) in folder.`,
        );
      } else {
        setIsError(true);
        setStatusLine(json.message || 'Failed to load.');
      }
    } catch (err) {
      setStatusCode(null);
      setIsError(true);
      setStatusLine(`Network error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  const locales = (data && data.locales) || [];
  const screenshots = (data && data.screenshots) || [];
  const usable = screenshots.filter(s => s.displayType && !s.error);
  const selectedLocales = locales.filter(l => selected[l]);
  const allSelected =
    locales.length > 0 && selectedLocales.length === locales.length;

  function toggle(locale) {
    setSelected(s => ({...s, [locale]: !s[locale]}));
  }
  function toggleAll() {
    const v = !allSelected;
    const next = {};
    locales.forEach(l => {
      next[l] = v;
    });
    setSelected(next);
  }

  async function submit() {
    setSubmitting(true);
    setIsError(false);
    setResults([]);
    setStatusCode(null);
    setStatusLine(
      `Uploading ${usable.length} screenshot(s) to ${selectedLocales.length} locale(s)...`,
    );
    try {
      const res = await api('/screenshots/push', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({locales: selectedLocales, replace}),
      });
      const json = await res.json();
      setStatusCode(res.status);
      setResults(json.results || []);
      setIsError(!res.ok);
      setStatusLine(
        res.ok
          ? 'Uploaded to all selected locales.'
          : res.status === 207
          ? 'Some locales failed — see below.'
          : json.message || 'Upload failed.',
      );
    } catch (err) {
      setStatusCode(null);
      setIsError(true);
      setStatusLine(`Network error: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    !submitting && usable.length > 0 && selectedLocales.length > 0;
  const badge =
    statusCode == null ? (isError ? 'NET ERR' : '—') : `HTTP ${statusCode}`;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Screenshots</Text>
      <Text style={styles.subtitle}>
        Upload the images in your folder to the locales you pick (editable
        version). Same images go to every selected locale.
      </Text>

      {data && data.version ? (
        <View style={styles.versionBanner}>
          <Text style={styles.versionText}>
            Target: v{data.version.versionString} · {data.version.state}
          </Text>
        </View>
      ) : null}

      {loading ? <ActivityIndicator style={{marginTop: 16}} /> : null}

      <Text style={styles.label}>Source folder</Text>
      <Text style={styles.fieldNote}>
        {data && data.dir ? data.dir : '(SCREENSHOTS_DIR not set in .env)'}
      </Text>
      {data && data.screenshotsError ? (
        <Text style={styles.error}>{data.screenshotsError}</Text>
      ) : null}

      {screenshots.map(s => (
        <View key={s.fileName} style={styles.shotRow}>
          <Text style={styles.shotName} numberOfLines={1}>
            {s.fileName}
          </Text>
          <Text style={s.error ? styles.error : styles.shotMeta}>
            {s.width && s.height ? `${s.width}×${s.height}` : ''}
            {s.displayType ? ` · ${s.displayType}` : ''}
            {s.error ? ` · ${s.error}` : ''}
          </Text>
        </View>
      ))}
      {screenshots.length > 0 ? (
        <Text style={styles.fieldNote}>
          {usable.length} of {screenshots.length} usable.
        </Text>
      ) : null}

      <View style={{marginTop: 12}}>
        <Checkbox
          label="Replace existing screenshots in each set"
          value={replace}
          onValueChange={setReplace}
          disabled={submitting}
        />
      </View>

      <View style={styles.localeHeaderRow}>
        <Text style={styles.label}>
          Locales ({selectedLocales.length}/{locales.length})
        </Text>
        {locales.length > 0 ? (
          <Checkbox
            label={allSelected ? 'Unselect all' : 'Select all'}
            value={allSelected}
            onValueChange={toggleAll}
            disabled={submitting}
          />
        ) : null}
      </View>
      {locales.map(l => (
        <View key={l} style={styles.localePickRow}>
          <Checkbox
            label={localeLabel(l)}
            value={!!selected[l]}
            onValueChange={() => toggle(l)}
            disabled={submitting}
          />
        </View>
      ))}

      <View style={styles.button}>
        <AppButton
          title={submitting ? 'Uploading...' : 'Submit screenshots'}
          onPress={submit}
          disabled={!canSubmit}
        />
      </View>
      <View style={styles.button}>
        <AppButton
          title="Reload"
          variant="secondary"
          onPress={load}
          disabled={submitting}
        />
      </View>

      {submitting ? <ActivityIndicator style={{marginTop: 16}} /> : null}

      <View style={styles.statusBlock}>
        <View style={styles.statusRow}>
          <Text
            style={[
              styles.badgeBase,
              isError ? styles.badgeError : styles.badgeOk,
            ]}>
            {badge}
          </Text>
          <Text style={[styles.statusLine, isError ? styles.error : styles.ok]}>
            {statusLine}
          </Text>
        </View>
      </View>

      {results.map(r => (
        <View key={r.locale} style={styles.localeCard}>
          <View style={styles.localeHeader}>
            <Text style={styles.localeName}>{localeLabel(r.locale)}</Text>
            <Text
              style={[
                styles.badgeBase,
                r.ok ? styles.badgeOk : styles.badgeError,
              ]}>
              HTTP {r.status}
            </Text>
          </View>
          {r.ok ? (
            <Text style={styles.shotMeta}>
              Uploaded {r.uploaded} — {JSON.stringify(r.sets)}
            </Text>
          ) : (
            <Text style={styles.localeError}>
              {r.message}
              {r.appleErrors && r.appleErrors.length
                ? `\nApple: ${r.appleErrors[0].detail || ''}`
                : ''}
            </Text>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// A/B test tab — upload each experiment variant's screenshots, per locale.
// ---------------------------------------------------------------------------
function ABTestTab({api, data, onReload}) {
  const experiments = (data && data.experiments) || [];
  const [sel, setSel] = useState({}); // treatmentId -> { locale: bool }
  const [replace, setReplace] = useState({}); // treatmentId -> bool (default true)
  const [busy, setBusy] = useState(null); // treatmentId currently uploading
  const [results, setResults] = useState({}); // treatmentId -> results[]
  const [status, setStatus] = useState({}); // treatmentId -> { line, isError, code }

  const repl = tid => replace[tid] !== false;
  const chosenLocales = (tid, locales) => {
    const m = sel[tid] || {};
    return locales.filter(l => m[l]);
  };
  function toggleLoc(tid, locale) {
    setSel(s => ({
      ...s,
      [tid]: {...(s[tid] || {}), [locale]: !(s[tid] || {})[locale]},
    }));
  }
  function toggleAll(tid, locales) {
    const v = chosenLocales(tid, locales).length !== locales.length;
    const next = {};
    locales.forEach(l => {
      next[l] = v;
    });
    setSel(s => ({...s, [tid]: next}));
  }

  async function upload(expId, variant) {
    const tid = variant.treatmentId;
    const locales = chosenLocales(tid, variant.locales || []);
    setBusy(tid);
    setResults(r => ({...r, [tid]: []}));
    setStatus(st => ({
      ...st,
      [tid]: {
        line: `Uploading ${variant.usableCount} screenshot(s) to ${locales.length} locale(s)...`,
        isError: false,
        code: null,
      },
    }));
    try {
      const res = await api('/abtests/screenshots/push', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          experimentId: expId,
          treatmentId: tid,
          locales,
          replace: repl(tid),
        }),
      });
      const json = await res.json();
      setResults(r => ({...r, [tid]: json.results || []}));
      setStatus(st => ({
        ...st,
        [tid]: {
          line: res.ok
            ? 'Uploaded to all selected locales.'
            : res.status === 207
            ? 'Some locales failed — see below.'
            : json.message || 'Upload failed.',
          isError: !res.ok,
          code: res.status,
        },
      }));
    } catch (err) {
      setStatus(st => ({
        ...st,
        [tid]: {line: `Network error: ${err.message}`, isError: true, code: null},
      }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>A/B test</Text>
      <Text style={styles.subtitle}>
        Upload each variant's screenshots (from its A/B folder) to the locales
        you pick.
      </Text>

      {experiments.length === 0 ? (
        <Text style={styles.fieldNote}>No A/B test on this app.</Text>
      ) : null}

      {experiments.map(exp => (
        <View key={exp.id}>
          <View style={styles.versionBanner}>
            <Text style={styles.versionText}>
              🧪 {exp.name} · {exp.pretty} · {exp.traffic}%
            </Text>
          </View>

          {exp.variants.map(variant => {
            const tid = variant.treatmentId;
            const locales = variant.locales || [];
            const chosen = chosenLocales(tid, locales);
            const allSel = locales.length > 0 && chosen.length === locales.length;
            const shots = variant.screenshots || [];
            const usable = shots.filter(s => s.displayType && !s.error);
            const st = status[tid] || {};
            const rs = results[tid] || [];
            const canUp = busy == null && usable.length > 0 && chosen.length > 0;
            return (
              <View key={tid} style={styles.variantCard}>
                <Text style={styles.variantTitle}>
                  Variant {variant.letter} — {variant.name}
                </Text>
                <Text style={styles.fieldNote}>
                  Folder: {variant.localDir || '(screenshotsDirForAb not set)'}
                </Text>
                {variant.localError ? (
                  <Text style={styles.error}>{variant.localError}</Text>
                ) : null}

                {shots.map(s => (
                  <View key={s.fileName} style={styles.shotRow}>
                    <Text style={styles.shotName} numberOfLines={1}>
                      {s.fileName}
                    </Text>
                    <Text style={s.error ? styles.error : styles.shotMeta}>
                      {s.width && s.height ? `${s.width}×${s.height}` : ''}
                      {s.displayType ? ` · ${s.displayType}` : ''}
                      {s.error ? ` · ${s.error}` : ''}
                    </Text>
                  </View>
                ))}
                <Text style={styles.fieldNote}>
                  {usable.length} usable screenshot(s).
                </Text>

                <View style={{marginTop: 8}}>
                  <Checkbox
                    label="Replace existing in each set"
                    value={repl(tid)}
                    onValueChange={v => setReplace(r => ({...r, [tid]: v}))}
                    disabled={busy === tid}
                  />
                </View>

                <View style={styles.localeHeaderRow}>
                  <Text style={styles.label}>
                    Locales ({chosen.length}/{locales.length})
                  </Text>
                  {locales.length > 0 ? (
                    <Checkbox
                      label={allSel ? 'Unselect all' : 'Select all'}
                      value={allSel}
                      onValueChange={() => toggleAll(tid, locales)}
                      disabled={busy === tid}
                    />
                  ) : null}
                </View>
                {locales.map(l => (
                  <View key={l} style={styles.localePickRow}>
                    <Checkbox
                      label={localeLabel(l)}
                      value={!!(sel[tid] || {})[l]}
                      onValueChange={() => toggleLoc(tid, l)}
                      disabled={busy === tid}
                    />
                  </View>
                ))}

                <View style={styles.button}>
                  <AppButton
                    title={
                      busy === tid
                        ? 'Uploading...'
                        : `Upload variant ${variant.letter}`
                    }
                    onPress={() => upload(exp.id, variant)}
                    disabled={!canUp}
                  />
                </View>

                {busy === tid ? (
                  <ActivityIndicator style={{marginTop: 8}} />
                ) : null}

                {st.line ? (
                  <View style={styles.statusBlock}>
                    <View style={styles.statusRow}>
                      <Text
                        style={[
                          styles.badgeBase,
                          st.isError ? styles.badgeError : styles.badgeOk,
                        ]}>
                        {st.code == null
                          ? st.isError
                            ? 'NET ERR'
                            : '—'
                          : `HTTP ${st.code}`}
                      </Text>
                      <Text
                        style={[
                          styles.statusLine,
                          st.isError ? styles.error : styles.ok,
                        ]}>
                        {st.line}
                      </Text>
                    </View>
                  </View>
                ) : null}

                {rs.map(r => (
                  <View key={r.locale} style={styles.localeCard}>
                    <View style={styles.localeHeader}>
                      <Text style={styles.localeName}>
                        {localeLabel(r.locale)}
                      </Text>
                      <Text
                        style={[
                          styles.badgeBase,
                          r.ok ? styles.badgeOk : styles.badgeError,
                        ]}>
                        HTTP {r.status}
                      </Text>
                    </View>
                    {r.ok ? (
                      <Text style={styles.shotMeta}>
                        Uploaded {r.uploaded} — {JSON.stringify(r.sets)}
                      </Text>
                    ) : (
                      <Text style={styles.localeError}>{r.message}</Text>
                    )}
                  </View>
                ))}
              </View>
            );
          })}
        </View>
      ))}

      <View style={styles.button}>
        <AppButton
          title="Reload"
          variant="secondary"
          onPress={onReload}
          disabled={busy != null}
        />
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Locales tab — add locales to the editable version.
// ---------------------------------------------------------------------------
function LocalesTab({api}) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null); // {version, primaryLocale, added, addable}
  const [sel, setSel] = useState({});
  const [adding, setAdding] = useState(false);
  const [statusCode, setStatusCode] = useState(null);
  const [statusLine, setStatusLine] = useState('');
  const [isError, setIsError] = useState(false);
  const [results, setResults] = useState([]);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setStatusLine('Loading locales...');
    setIsError(false);
    setResults([]);
    try {
      const res = await api('/locales');
      const json = await res.json();
      setStatusCode(res.status);
      setData(json);
      setSel({});
      if (res.ok && json.ok) {
        setStatusLine(
          `v${json.version.versionString} (${json.version.state}) · primary: ${
            json.primaryLocale || '?'
          }`,
        );
      } else {
        setIsError(true);
        setStatusLine(json.message || 'Failed to load.');
      }
    } catch (err) {
      setStatusCode(null);
      setIsError(true);
      setStatusLine(`Network error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  const added = (data && data.added) || [];
  const addable = (data && data.addable) || [];
  const primary = data && data.primaryLocale;
  const selected = addable.filter(l => sel[l]);
  const allSel = addable.length > 0 && selected.length === addable.length;
  function toggle(l) {
    setSel(s => ({...s, [l]: !s[l]}));
  }
  function toggleAll() {
    const v = !allSel;
    const n = {};
    addable.forEach(l => {
      n[l] = v;
    });
    setSel(n);
  }

  async function add() {
    if (selected.length === 0) return;
    setAdding(true);
    setIsError(false);
    setResults([]);
    setStatusCode(null);
    setStatusLine(`Adding ${selected.length} locale(s)...`);
    try {
      const res = await api('/locales/add', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({locales: selected}),
      });
      const json = await res.json();
      setStatusCode(res.status);
      setResults(json.results || []);
      setIsError(!res.ok);
      setStatusLine(
        res.ok
          ? `Added ${selected.length} locale(s).`
          : res.status === 207
          ? 'Some locales failed — see below.'
          : json.message || 'Add failed.',
      );
      await load();
    } catch (err) {
      setStatusCode(null);
      setIsError(true);
      setStatusLine(`Network error: ${err.message}`);
    } finally {
      setAdding(false);
    }
  }

  const badge =
    statusCode == null ? (isError ? 'NET ERR' : '—') : `HTTP ${statusCode}`;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Locales</Text>
      <Text style={styles.subtitle}>
        Add locales to the editable version. Metadata is edited from the primary
        locale on the Metadata tab.
      </Text>

      {data && data.version ? (
        <View style={styles.versionBanner}>
          <Text style={styles.versionText}>
            Target: v{data.version.versionString} · {data.version.state}
          </Text>
        </View>
      ) : null}

      {loading ? <ActivityIndicator style={{marginTop: 16}} /> : null}

      <Text style={styles.fieldNote}>
        Primary locale: {primary ? localeLabel(primary) : '—'}
      </Text>
      <Text style={styles.label}>Added ({added.length})</Text>
      <Text style={styles.fieldNote}>
        {added.map(localeLabel).join(', ') || '—'}
      </Text>

      {addable.length > 0 ? (
        <>
          <View style={styles.localeHeaderRow}>
            <Text style={styles.label}>
              Add locales ({selected.length}/{addable.length})
            </Text>
            <Checkbox
              label={allSel ? 'Unselect all' : 'Select all'}
              value={allSel}
              onValueChange={toggleAll}
              disabled={adding || loading}
            />
          </View>
          {addable.map(l => (
            <View key={l} style={styles.localePickRow}>
              <Checkbox
                label={localeLabel(l)}
                value={!!sel[l]}
                onValueChange={() => toggle(l)}
                disabled={adding || loading}
              />
            </View>
          ))}
          <View style={styles.button}>
            <AppButton
              title={adding ? 'Adding...' : 'Add selected locales'}
              onPress={add}
              disabled={adding || selected.length === 0}
            />
          </View>
        </>
      ) : data && data.version ? (
        <Text style={styles.fieldNote}>
          All supported locales are already added.
        </Text>
      ) : null}

      <View style={styles.button}>
        <AppButton title="Reload" variant="secondary" onPress={load} disabled={adding} />
      </View>

      {adding ? <ActivityIndicator style={{marginTop: 8}} /> : null}

      <View style={styles.statusBlock}>
        <View style={styles.statusRow}>
          <Text
            style={[
              styles.badgeBase,
              isError ? styles.badgeError : styles.badgeOk,
            ]}>
            {badge}
          </Text>
          <Text style={[styles.statusLine, isError ? styles.error : styles.ok]}>
            {statusLine}
          </Text>
        </View>
      </View>

      {results.map(r => (
        <View key={r.locale} style={styles.localeCard}>
          <View style={styles.localeHeader}>
            <Text style={styles.localeName}>{localeLabel(r.locale)}</Text>
            <Text
              style={[
                styles.badgeBase,
                r.ok ? styles.badgeOk : styles.badgeError,
              ]}>
              HTTP {r.status}
            </Text>
          </View>
          {!r.ok ? (
            <Text style={styles.localeError}>
              {r.message}
              {r.appleErrors && r.appleErrors.length
                ? `\nApple: ${r.appleErrors[0].detail || ''}`
                : ''}
            </Text>
          ) : r.message ? (
            <Text style={styles.shotMeta}>{r.message}</Text>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}

// Workspace = the per-app UI (Locales / Metadata / Screenshots) for one target.
// Remounted (via key) when the selected target changes, so state resets cleanly.
function Workspace({targetId, onChangeTarget, showChange}) {
  // Bound fetch: prepends the backend URL and the x-target-id header.
  const api = (path, opts = {}) =>
    fetch(`${config.backendUrl}${path}`, {
      ...opts,
      headers: {...(opts.headers || {}), 'x-target-id': targetId},
    });

  const [values, setValues] = useState({
    promotionalText: '',
    keywords: '',
    description: '',
    whatsNew: '',
    supportUrl: '',
    privacyPolicyUrl: '',
  });
  // Per-field flags. push = send this field at all; translate = translate per
  // locale (false = push the source text as-is to every locale).
  const [flags, setFlags] = useState({
    promotionalText: {push: true, translate: true},
    keywords: {push: true, translate: true},
    description: {push: true, translate: true},
    whatsNew: {push: true, translate: true},
    supportUrl: {push: true}, // URL — never translated
    privacyPolicyUrl: {push: true}, // App Info URL — never translated
  });
  const [tab, setTab] = useState('metadata'); // 'locales' | 'metadata' | 'screenshots' | 'abtest'
  const [abData, setAbData] = useState(null); // { experiments: [...] } | null
  const [app, setApp] = useState(null); // { name, bundleId }
  const [version, setVersion] = useState(null); // { versionString, state }
  const [statusCode, setStatusCode] = useState(null);
  const [statusLine, setStatusLine] = useState('');
  const [results, setResults] = useState([]);
  const [isError, setIsError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [canPush, setCanPush] = useState(false);

  useEffect(() => {
    loadApp();
    loadMetadata();
    loadAbtests();
  }, []);

  function setField(key, text) {
    setValues(v => ({...v, [key]: text}));
  }

  function setFlag(key, flag, val) {
    setFlags(f => ({...f, [key]: {...f[key], [flag]: val}}));
  }

  // Load which app the current credentials point at (name + bundle id).
  async function loadApp() {
    try {
      const res = await api('/app');
      const json = await res.json();
      if (res.ok && json.ok) setApp(json.app);
      else setApp(null);
    } catch (err) {
      setApp(null);
    }
  }

  // Load A/B tests to decide whether to show the tab (and feed the tab data).
  async function loadAbtests() {
    try {
      const res = await api('/abtests');
      const json = await res.json();
      setAbData(res.ok && json.ok ? json : null);
    } catch (err) {
      setAbData(null);
    }
  }

  async function loadMetadata() {
    setStatusLine('Finding editable version...');
    setIsError(false);
    setResults([]);
    setCanPush(false);
    try {
      const res = await api('/metadata');
      const json = await res.json();
      setStatusCode(res.status);
      if (res.ok && json.ok) {
        setVersion(json.version);
        setValues({
          promotionalText: json.fields.promotionalText || '',
          keywords: json.fields.keywords || '',
          description: json.fields.description || '',
          whatsNew: json.fields.whatsNew || '',
          supportUrl: json.fields.supportUrl || '',
          privacyPolicyUrl: json.fields.privacyPolicyUrl || '',
        });
        setCanPush(true);
        setStatusLine(
          `v${json.version.versionString} (${json.version.state}) · ` +
            `primary locale: ${json.baseLocale || json.primaryLocale || '?'}`,
        );
      } else {
        setIsError(true);
        setVersion(null);
        setStatusLine(json.message || 'No editable version.');
      }
    } catch (err) {
      setStatusCode(null);
      setIsError(true);
      setStatusLine(`Network error: ${err.message}`);
    }
  }

  async function push() {
    setLoading(true);
    setStatusLine('Pushing selected fields to every locale...');
    setIsError(false);
    setResults([]);
    setStatusCode(null);

    // Build the per-field payload from values + flags.
    const payload = {};
    FIELDS.forEach(f => {
      const fl = flags[f.key] || {};
      payload[f.key] = f.url
        ? {value: values[f.key], push: !!fl.push}
        : {value: values[f.key], push: !!fl.push, translate: !!fl.translate};
    });

    try {
      const res = await api('/metadata', {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      setStatusCode(res.status);
      setResults(Array.isArray(json.results) ? json.results : []);
      setIsError(!res.ok);
      if (json.version) setVersion(json.version);

      if (res.ok) {
        setStatusLine(
          `Pushed ${(json.updatedFields || []).join(', ')} to all locales.`,
        );
      } else if (res.status === 207) {
        setStatusLine('Some locales failed — see details below.');
      } else {
        setStatusLine(json.message || 'Push failed.');
      }
    } catch (err) {
      setStatusCode(null);
      setIsError(true);
      setStatusLine(`Network error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  function badge() {
    if (statusCode == null) return isError ? 'NET ERR' : '—';
    return `HTTP ${statusCode}`;
  }

  const pushTitle = version
    ? `Translate & push to v${version.versionString}`
    : 'Translate & push';

  return (
    <SafeAreaView style={styles.safe}>
      {/* App name + Change-app button — always visible above the tabs */}
      <View style={styles.appHeader}>
        <View style={{flex: 1}}>
          <Text style={styles.appName} numberOfLines={1}>
            {app && app.name ? app.name : 'Loading app…'}
          </Text>
          {app && app.bundleId ? (
            <Text style={styles.appBundle} numberOfLines={1}>
              {app.bundleId}
            </Text>
          ) : null}
        </View>
        {showChange ? (
          <TouchableOpacity
            onPress={onChangeTarget}
            style={styles.changeBtn}
            activeOpacity={0.7}>
            <Text style={styles.changeBtnText}>{'<=='} Back</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Tab bar */}
      <View style={styles.tabBar}>
        <TabButton
          label="Locales"
          active={tab === 'locales'}
          onPress={() => setTab('locales')}
        />
        <TabButton
          label="Metadata"
          active={tab === 'metadata'}
          onPress={() => setTab('metadata')}
        />
        <TabButton
          label="Screenshots"
          active={tab === 'screenshots'}
          onPress={() => setTab('screenshots')}
        />
        {abData && abData.experiments && abData.experiments.length > 0 ? (
          <TabButton
            label="A/B test"
            active={tab === 'abtest'}
            onPress={() => setTab('abtest')}
          />
        ) : null}
      </View>

      {tab === 'locales' ? (
        <LocalesTab api={api} />
      ) : tab === 'screenshots' ? (
        <ScreenshotsTab api={api} />
      ) : tab === 'abtest' ? (
        <ABTestTab api={api} data={abData} onReload={loadAbtests} />
      ) : (
        <KeyboardAvoidingView
          style={{flex: 1}}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.container}>
            <Text style={styles.title}>App Store Metadata</Text>
            <Text style={styles.subtitle}>
              Type once. Each field is translated into every open locale's
              language and pushed to the editable version.
            </Text>

            {/* Target version banner */}
            {version ? (
              <View style={styles.versionBanner}>
                <Text style={styles.versionText}>
                  Target: v{version.versionString} · {version.state}
                </Text>
              </View>
            ) : null}

            {FIELDS.map(f => (
              <View key={f.key}>
                <Text style={styles.label}>{f.label}</Text>
                {f.note ? <Text style={styles.fieldNote}>{f.note}</Text> : null}

                {/* Per-field controls: Translate (text only) + Push */}
                <View style={styles.cbRow}>
                  {!f.url ? (
                    <Checkbox
                      label="Translate"
                      value={!!flags[f.key].translate}
                      disabled={loading || !flags[f.key].push}
                      onValueChange={v => setFlag(f.key, 'translate', v)}
                    />
                  ) : null}
                  <Checkbox
                    label="Push"
                    value={!!flags[f.key].push}
                    disabled={loading}
                    onValueChange={v => setFlag(f.key, 'push', v)}
                  />
                </View>

                <TextInput
                  style={[styles.input, f.big && styles.inputBig]}
                  value={values[f.key]}
                  onChangeText={t => setField(f.key, t)}
                  placeholder={f.url ? 'https://...' : `Type ${f.label}...`}
                  multiline={!f.url}
                  maxLength={f.max}
                  editable={!loading}
                  keyboardType={f.url ? 'url' : 'default'}
                  autoCapitalize={
                    f.key === 'keywords' || f.url ? 'none' : 'sentences'
                  }
                  autoCorrect={!f.url}
                />
                <Text style={styles.counter}>
                  {values[f.key].length}/{f.max}
                </Text>
              </View>
            ))}

            <View style={styles.button}>
              <AppButton
                title={loading ? 'Working...' : pushTitle}
                onPress={push}
                disabled={loading || !canPush}
              />
            </View>
            <View style={styles.button}>
              <AppButton
                title="Reload"
                variant="secondary"
                onPress={loadMetadata}
                disabled={loading}
              />
            </View>

            {loading && <ActivityIndicator style={{marginTop: 16}} />}

            {/* Top-level status: English line + Ukrainian duplicate below it. */}
            <View style={styles.statusBlock}>
              <View style={styles.statusRow}>
                <Text
                  style={[
                    styles.badgeBase,
                    isError ? styles.badgeError : styles.badgeOk,
                  ]}>
                  {badge()}
                </Text>
                <Text
                  style={[
                    styles.statusLine,
                    isError ? styles.error : styles.ok,
                  ]}>
                  {statusLine}
                </Text>
              </View>
              {toUkrainian(statusLine) ? (
                <Text
                  style={[styles.statusUk, isError ? styles.error : styles.ok]}>
                  🇺🇦 {toUkrainian(statusLine)}
                </Text>
              ) : null}
            </View>

            {/* Per-locale results */}
            {results.map(r => (
              <View
                key={r.localizationId || r.locale}
                style={styles.localeCard}>
                <View style={styles.localeHeader}>
                  <Text style={styles.localeName}>{localeLabel(r.locale)}</Text>
                  <Text
                    style={[
                      styles.badgeBase,
                      r.ok ? styles.badgeOk : styles.badgeError,
                    ]}>
                    HTTP {r.status}
                  </Text>
                </View>
                {r.translated
                  ? Object.keys(r.translated).map(k => (
                      <View key={k} style={styles.fieldRow}>
                        <Text style={styles.fieldKey}>{k}</Text>
                        <Text style={styles.fieldVal} numberOfLines={4}>
                          {r.translated[k]}
                        </Text>
                      </View>
                    ))
                  : null}
                {!r.ok ? (
                  <Text style={styles.localeError}>
                    {r.message}
                    {r.appleErrors && r.appleErrors.length
                      ? `\nApple: ${r.appleErrors[0].detail || ''}`
                      : ''}
                  </Text>
                ) : null}
              </View>
            ))}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Root: pick an app target, then render its Workspace.
// ---------------------------------------------------------------------------
export default function App() {
  const [targets, setTargets] = useState(null); // null=loading, []=none, [...]
  const [error, setError] = useState('');
  const [targetId, setTargetId] = useState(null);

  useEffect(() => {
    loadTargets();
  }, []);

  async function loadTargets() {
    setError('');
    setTargets(null);
    try {
      const res = await fetch(`${config.backendUrl}/targets`);
      const json = await res.json();
      const list = (json && json.targets) || [];
      setTargets(list);
      if (list.length === 1) setTargetId(list[0].id); // auto-select the only one
    } catch (err) {
      setError(`Network error: ${err.message}`);
      setTargets([]);
    }
  }

  // A target is selected → show its workspace.
  if (targetId != null) {
    return (
      <Workspace
        key={targetId}
        targetId={targetId}
        showChange={(targets || []).length > 1}
        onChangeTarget={() => setTargetId(null)}
      />
    );
  }

  // Otherwise show the app picker.
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Choose an app</Text>
        <Text style={styles.subtitle}>
          Pick which app to work with. Configure them in backend/apps.json.
        </Text>

        {targets == null ? (
          <ActivityIndicator style={{marginTop: 24}} />
        ) : targets.length === 0 ? (
          <Text style={[styles.error, {marginTop: 16}]}>
            {error ||
              'No app targets configured. Add backend/apps.json (or set ISSUER_ID/KEY_ID/APP_ID in .env).'}
          </Text>
        ) : (
          targets.map(t => (
            <TouchableOpacity
              key={t.id}
              style={styles.appCard}
              activeOpacity={0.7}
              onPress={() => setTargetId(t.id)}>
              <Text style={styles.appCardName}>{t.name}</Text>
              <Text style={styles.appCardId}>appId {t.appId}</Text>
            </TouchableOpacity>
          ))
        )}

        <View style={[styles.button, {marginTop: 16}]}>
          <AppButton title="Reload" variant="secondary" onPress={loadTargets} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: '#fff'},
  container: {padding: 20, paddingBottom: 60},
  appHeader: {
    paddingHorizontal: 20,
    paddingTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  appName: {fontSize: 18, fontWeight: '700', color: '#1a3e8c'},
  appBundle: {fontSize: 12, color: '#888', marginTop: 2},
  changeBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1a3e8c',
    marginLeft: 10,
  },
  changeBtnText: {color: '#1a3e8c', fontWeight: '600', fontSize: 13},
  appCard: {
    marginTop: 12,
    padding: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    backgroundColor: '#fafafa',
  },
  appCardName: {fontSize: 17, fontWeight: '700', color: '#1a3e8c'},
  appCardId: {fontSize: 12, color: '#888', marginTop: 3},
  tabBar: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  tabBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#f2f2f2',
  },
  tabBtnActive: {backgroundColor: '#1a3e8c'},
  tabBtnText: {fontSize: 14, fontWeight: '600', color: '#333'},
  tabBtnTextActive: {color: '#fff'},
  shotRow: {
    marginTop: 8,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  shotName: {fontSize: 14, fontWeight: '600', color: '#222'},
  shotMeta: {fontSize: 12, color: '#666', marginTop: 2},
  localeHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  localePickRow: {paddingVertical: 4},
  addBlock: {
    marginBottom: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  title: {fontSize: 24, fontWeight: '700', marginTop: 4},
  subtitle: {fontSize: 13, color: '#666', marginTop: 4, marginBottom: 12},
  versionBanner: {
    backgroundColor: '#eef4ff',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  versionText: {color: '#1a3e8c', fontWeight: '600', fontSize: 13},
  label: {fontSize: 14, fontWeight: '600', marginTop: 10, marginBottom: 6},
  fieldNote: {
    fontSize: 12,
    color: '#888',
    marginBottom: 6,
    fontStyle: 'italic',
  },
  cbRow: {flexDirection: 'row', gap: 18, marginBottom: 8},
  cb: {flexDirection: 'row', alignItems: 'center'},
  cbBox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#888',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  cbBoxOn: {backgroundColor: '#1a3e8c', borderColor: '#1a3e8c'},
  cbBoxDisabled: {borderColor: '#ddd', backgroundColor: '#f4f4f4'},
  cbCheck: {color: '#fff', fontSize: 13, fontWeight: '700', lineHeight: 16},
  cbLabel: {fontSize: 13, color: '#333'},
  cbLabelDisabled: {color: '#bbb'},
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
    minHeight: 44,
    textAlignVertical: 'top',
  },
  inputBig: {minHeight: 110},
  counter: {alignSelf: 'flex-end', color: '#999', marginTop: 4},
  button: {marginVertical: 6},
  btn: {
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimary: {backgroundColor: '#1a3e8c'},
  btnSecondary: {backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#1a3e8c'},
  btnDisabled: {backgroundColor: '#c7c7cc', borderColor: '#c7c7cc'},
  btnText: {fontSize: 16, fontWeight: '700'},
  btnTextPrimary: {color: '#fff'},
  btnTextSecondary: {color: '#1a3e8c'},
  btnTextDisabled: {color: '#8e8e93'},
  statusBlock: {marginTop: 18},
  statusRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  statusUk: {fontSize: 13, marginTop: 6, opacity: 0.85},
  badgeBase: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    overflow: 'hidden',
  },
  badgeOk: {backgroundColor: '#1b7f2e'},
  badgeError: {backgroundColor: '#b00020'},
  statusLine: {flex: 1, fontSize: 13},
  ok: {color: '#1b7f2e'},
  error: {color: '#b00020'},
  localeCard: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 8,
    padding: 12,
    backgroundColor: '#fafafa',
  },
  localeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  localeName: {fontSize: 16, fontWeight: '600'},
  variantCard: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#d8d8e0',
    borderRadius: 10,
    padding: 14,
    backgroundColor: '#f6f7fb',
  },
  variantTitle: {fontSize: 16, fontWeight: '700', color: '#1a3e8c', marginBottom: 4},
  fieldRow: {marginTop: 6},
  fieldKey: {fontSize: 11, color: '#888', fontWeight: '600'},
  fieldVal: {fontSize: 13, color: '#222', lineHeight: 18},
  localeError: {fontSize: 13, color: '#b00020', marginTop: 6},
});
