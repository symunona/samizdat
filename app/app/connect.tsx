import { useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Platform,
    Pressable,
    SafeAreaView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useUnistyles } from "react-native-unistyles";
import { health, pair } from "../src/api";
import { clearConnection, saveConnection } from "../src/storage";
import { useConnection } from "../src/ConnectionContext";
import { QRScannerModal } from "../src/QRScannerModal";

function defaultServerUrl(): string {
    if (Platform.OS === "web" && typeof window !== "undefined") {
        return window.location.origin;
    }
    return "http://localhost:8765";
}

function deviceName(): string {
    if (Platform.OS === "web" && typeof navigator !== "undefined") {
        const ua = navigator.userAgent;
        const browser = /Edg/.test(ua)
            ? "Edge"
            : /Chrome/.test(ua)
              ? "Chrome"
              : /Firefox/.test(ua)
                ? "Firefox"
                : /Safari/.test(ua)
                  ? "Safari"
                  : "Browser";
        const os = /Windows/.test(ua)
            ? "Windows"
            : /Mac OS/.test(ua)
              ? "Mac"
              : /Linux/.test(ua)
                ? "Linux"
                : /Android/.test(ua)
                  ? "Android"
                  : /iPhone|iPad/.test(ua)
                    ? "iOS"
                    : "Unknown";
        const host =
            typeof window !== "undefined" ? window.location.hostname : "";
        return host && host !== "localhost"
            ? `${browser} @ ${host}`
            : `${browser} on ${os}`;
    }
    const plat =
        Platform.OS === "ios"
            ? "iPhone"
            : Platform.OS === "android"
              ? "Android"
              : Platform.OS;
    return `Samizdat ${plat}`;
}

function splitUrls(raw: string): string[] {
    return raw
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function mergeUrls(primary: string, apiUrls: string[]): string[] {
    return [primary, ...apiUrls.filter((u) => u !== primary)];
}

type Status =
    | { kind: "idle" }
    | { kind: "connecting" }
    | { kind: "error"; message: string };

type ParseResult =
    | { ok: true; code: string; urls: string[] }
    | { ok: false; reason: string };

function parseConnectString(raw: string): ParseResult {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, reason: "" };
    try {
        const json = atob(trimmed);
        const obj = JSON.parse(json);
        if (
            obj.v !== 1 ||
            typeof obj.code !== "string" ||
            !Array.isArray(obj.urls)
        ) {
            return { ok: false, reason: "Unrecognised format" };
        }
        const urls = (obj.urls as string[]).map((u) =>
            /^https?:\/\//.test(u) ? u : `http://${u}`,
        );
        return { ok: true, code: obj.code as string, urls };
    } catch {
        return { ok: false, reason: "Invalid connect string" };
    }
}

export default function ConnectScreen() {
    const { theme } = useUnistyles();
    const s = useMemo(() => buildStyles(theme), [theme]);
    const router = useRouter();
    const { reload } = useConnection();

    const [url, setUrl] = useState(defaultServerUrl);
    const [code, setCode] = useState("");
    const [status, setStatus] = useState<Status>({ kind: "idle" });
    const [hasCamera, setHasCamera] = useState(false);
    const [scannerOpen, setScannerOpen] = useState(false);

    // Detect camera availability once on mount
    useEffect(() => {
        if (Platform.OS === "web") {
            if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
            navigator.mediaDevices.enumerateDevices().then((devices) => {
                const hasVideo = devices.some((d) => d.kind === "videoinput");
                // BarcodeDetector required for web scanning
                // @ts-expect-error BarcodeDetector not in TS lib yet
                const hasBarcodeDetector = typeof BarcodeDetector !== "undefined";
                setHasCamera(hasVideo && hasBarcodeDetector);
            }).catch(() => {});
        } else {
            // All iOS/Android devices have cameras; show the button, handle permission in modal
            setHasCamera(true);
        }
    }, []);

    function handleQRScan(data: string) {
        setScannerOpen(false);
        const parsed = parseConnectString(data);
        if (!parsed.ok) {
            setStatus({ kind: "error", message: parsed.reason || "Invalid QR code" });
            return;
        }
        // Keep existing URLs (e.g. sam.tmpx.space) as primary; append scanned IPs
        const existing = splitUrls(url);
        const merged = [...existing];
        for (const u of parsed.urls) {
            const full = /^https?:\/\//.test(u) ? u : `http://${u}`;
            if (!merged.includes(full)) merged.push(full);
        }
        const primaryUrl = merged[0] ?? defaultServerUrl();
        setCode(parsed.code);
        setUrl(merged.join("\n"));
        setStatus({ kind: "connecting" });
        pair(primaryUrl, parsed.code, deviceName())
            .then(async (paired) => {
                const serverUrls = mergeUrls(primaryUrl, [...merged.slice(1), ...(paired.server_urls ?? [])]);
                await saveConnection({
                    token: paired.device_token,
                    deviceId: paired.device_id,
                    serverUrls,
                });
                await reload();
                router.replace("/");
            })
            .catch((e: unknown) => {
                setStatus({
                    kind: "error",
                    message: e instanceof Error ? e.message : "Connection failed",
                });
            });
    }

    // Auto-connect from URL params emitted by `sam connect`
    const urlParamHandled = useRef(false);
    useEffect(() => {
        if (urlParamHandled.current) return;
        if (Platform.OS !== "web" || typeof window === "undefined") return;
        const params = new URLSearchParams(window.location.search);

        // ?code=XXXX-XXXX — simple link from terminal; server URL = this page's origin
        const codeParam = params.get("code");
        if (codeParam) {
            urlParamHandled.current = true;
            const serverUrl = window.location.origin;
            setCode(codeParam);
            setUrl(serverUrl);
            setStatus({ kind: "connecting" });
            pair(serverUrl, codeParam, deviceName())
                .then(async (paired) => {
                    const serverUrls = mergeUrls(serverUrl, paired.server_urls ?? []);
                    await saveConnection({
                        token: paired.device_token,
                        deviceId: paired.device_id,
                        serverUrls,
                    });
                    await reload();
                    router.replace("/");
                })
                .catch((e: unknown) => {
                    setStatus({
                        kind: "error",
                        message: e instanceof Error ? e.message : "Connection failed",
                    });
                });
            return;
        }

        // ?c=<base64> — full connect string (QR scan flow)
        const c = params.get("c");
        if (!c) return;
        urlParamHandled.current = true;
        const parsed = parseConnectString(c);
        if (!parsed.ok) return;
        const primaryUrl = parsed.urls[0] ?? defaultServerUrl();
        setCode(parsed.code);
        setUrl(parsed.urls[0] ?? defaultServerUrl());
        setStatus({ kind: "connecting" });
        pair(primaryUrl, parsed.code, deviceName())
            .then(async (paired) => {
                const serverUrls = mergeUrls(primaryUrl, paired.server_urls ?? []);
                await saveConnection({
                    token: paired.device_token,
                    deviceId: paired.device_id,
                    serverUrls,
                });
                await reload();
                router.replace("/");
            })
            .catch((e: unknown) => {
                setStatus({
                    kind: "error",
                    message: e instanceof Error ? e.message : "Connection failed",
                });
            });
    }, [reload, router]);

    async function connect() {
        setStatus({ kind: "connecting" });
        try {
            if (!code.trim())
                throw new Error("Enter the pairing code from `sam connect`.");
            const urlList = splitUrls(url);
            const primaryUrl = urlList[0];
            if (!primaryUrl) throw new Error("Enter a server URL.");
            const result = await pair(primaryUrl, code.trim(), deviceName());
            const serverUrls = mergeUrls(primaryUrl, result.server_urls ?? []);
            await saveConnection({
                token: result.device_token,
                deviceId: result.device_id,
                serverUrls,
            });
            await reload();
            router.replace("/");
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "Connection failed";
            try {
                const primaryUrl = splitUrls(url)[0] ?? url;
                const h = await health(primaryUrl);
                setStatus({
                    kind: "error",
                    message: `Server reachable (${h.status}) but not paired — ${msg}`,
                });
            } catch {
                setStatus({ kind: "error", message: msg });
            }
        }
    }

    async function disconnect() {
        await clearConnection();
        await reload();
    }

    return (
        <SafeAreaView style={s.screen}>
            <StatusBar style="light" />
            <View style={s.card}>
                <Ionicons
                    name="library"
                    size={64}
                    color={theme.colors.accent}
                    style={s.logo}
                />
                <Text style={s.brand}>samizdat</Text>
                <Text style={s.sub}>Connect to your server</Text>

                <Text style={s.code}>sam connect</Text>
                <Text style={s.hint}>Click the link it prints to connect automatically.</Text>

                <View style={s.divider} />

                <Text style={s.label}>Server URLs (one per line)</Text>
                <TextInput
                    style={[s.input, s.inputMulti]}
                    autoCapitalize="none"
                    autoCorrect={false}
                    multiline
                    numberOfLines={3}
                    placeholder={"https://samizdat.example.com\nhttp://100.x.x.x:8765"}
                    placeholderTextColor={theme.colors.placeholder}
                    value={url}
                    onChangeText={setUrl}
                />
                {splitUrls(url).length > 1 && (
                    <View style={s.chips}>
                        {splitUrls(url).map((u, i) => (
                            <View key={u} style={[s.chip, i === 0 && s.chipPrimary]}>
                                <Text style={[s.chipText, i === 0 && s.chipTextPrimary]}>
                                    {i === 0 ? "★ " : ""}{u}
                                </Text>
                            </View>
                        ))}
                    </View>
                )}

                <Text style={s.label}>Pairing code</Text>
                <TextInput
                    style={s.input}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    placeholder="XXXX-XXXX"
                    placeholderTextColor={theme.colors.placeholder}
                    value={code}
                    onChangeText={setCode}
                />

                <Pressable
                    style={({ pressed }) => [
                        s.button,
                        pressed && s.buttonPressed,
                    ]}
                    onPress={connect}
                    disabled={status.kind === "connecting"}
                >
                    {status.kind === "connecting" ? (
                        <ActivityIndicator color={theme.colors.background} />
                    ) : (
                        <Text style={s.buttonText}>Connect</Text>
                    )}
                </Pressable>

                {hasCamera && (
                    <Pressable style={s.ghost} onPress={() => setScannerOpen(true)}>
                        <Text style={s.ghostText}>Scan QR code</Text>
                    </Pressable>
                )}

                <QRScannerModal
                    visible={scannerOpen}
                    onScan={handleQRScan}
                    onClose={() => setScannerOpen(false)}
                />

                {status.kind === "error" && (
                    <Text style={s.errorText}>{status.message}</Text>
                )}

                <Pressable style={s.ghost} onPress={disconnect}>
                    <Text style={s.ghostText}>Clear saved connection</Text>
                </Pressable>
            </View>
        </SafeAreaView>
    );
}

type Theme = ReturnType<typeof useUnistyles>["theme"];

function buildStyles(t: Theme) {
    return StyleSheet.create({
        screen: {
            flex: 1,
            backgroundColor: t.colors.background,
            justifyContent: "center",
            alignItems: "center",
        },
        card: {
            paddingHorizontal: t.spacing.xl,
            gap: t.spacing.sm,
            width: "100%",
            maxWidth: 440,
        },
        logo: { marginBottom: 8, alignSelf: "center" },
        brand: {
            color: t.colors.text,
            fontSize: 34,
            fontWeight: "800",
            letterSpacing: -1,
            marginBottom: 4,
            textAlign: "center",
        },
        sub: { color: t.colors.muted, fontSize: 15, marginBottom: 8, textAlign: "center" },
        label: {
            color: t.colors.muted,
            fontSize: 13,
            marginTop: 12,
            marginBottom: 6,
        },
        input: {
            backgroundColor: t.colors.surface,
            color: t.colors.text,
            borderRadius: t.radius.md,
            borderWidth: 1,
            borderColor: t.colors.border,
            paddingHorizontal: t.spacing.md,
            paddingVertical: 12,
            fontSize: 16,
        },
        inputMulti: {
            minHeight: 72,
            textAlignVertical: "top",
        },
        chips: {
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 6,
            marginTop: 4,
        },
        chip: {
            backgroundColor: t.colors.surface,
            borderWidth: 1,
            borderColor: t.colors.border,
            borderRadius: 20,
            paddingHorizontal: 10,
            paddingVertical: 4,
        },
        chipPrimary: {
            borderColor: t.colors.accent,
            backgroundColor: t.colors.accent + "22",
        },
        chipText: {
            color: t.colors.muted,
            fontSize: 12,
        },
        chipTextPrimary: {
            color: t.colors.accent,
            fontWeight: "600",
        },
        button: {
            backgroundColor: t.colors.accent,
            borderRadius: t.radius.md,
            paddingVertical: 14,
            alignItems: "center",
            marginTop: t.spacing.lg,
        },
        buttonPressed: { opacity: 0.85 },
        buttonText: {
            color: t.colors.background,
            fontSize: 16,
            fontWeight: "700",
        },
        ghost: { alignItems: "center", paddingVertical: 12 },
        ghostText: { color: t.colors.placeholder, fontSize: 14 },
        hint: { color: t.colors.muted, fontSize: 13, textAlign: "center" },
        divider: {
            height: 1,
            backgroundColor: t.colors.border,
            marginVertical: t.spacing.md,
        },
        code: {
            color: t.colors.accent,
            fontSize: 16,
            fontFamily: "monospace",
            fontWeight: "700",
            textAlign: "center",
        },
        errorText: {
            color: t.colors.error,
            fontSize: 14,
            lineHeight: 20,
            marginTop: 8,
        },
    });
}
