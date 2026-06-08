import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { health, me, pair } from "./src/api";

type Status =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "online"; detail: string }
  | { kind: "error"; message: string };

// Milestone 1, step-1 screen: connect to the server and confirm we're online.
// Pairing code comes from `sam qr` on the server. QR camera scan is a refinement.
export default function App() {
  const [url, setUrl] = useState("http://localhost:8787");
  const [code, setCode] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function connect() {
    setStatus({ kind: "connecting" });
    try {
      let t = token;
      if (!t) {
        if (!code.trim()) throw new Error("Enter the pairing code from `sam qr`.");
        t = (await pair(url, code.trim())).device_token;
        setToken(t);
      }
      const info = await me(url, t);
      setStatus({
        kind: "online",
        detail: `${info.device_id} · server ${info.server_version ?? "?"}`,
      });
    } catch (e: any) {
      // Still try public health so we can distinguish "unreachable" from "unpaired".
      try {
        const h = await health(url);
        setStatus({
          kind: "error",
          message: `Server reachable (${h.status}) but not paired — ${e.message}`,
        });
      } catch {
        setStatus({ kind: "error", message: e.message ?? "Connection failed" });
      }
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.card}>
        <Text style={styles.brand}>samizdat</Text>
        <Text style={styles.sub}>Connect to your server</Text>

        <Text style={styles.label}>Server URL</Text>
        <TextInput
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://samizdat.example.com"
          placeholderTextColor="#6b7280"
          value={url}
          onChangeText={setUrl}
        />

        <Text style={styles.label}>Pairing code</Text>
        <TextInput
          style={styles.input}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="from `sam qr`"
          placeholderTextColor="#6b7280"
          value={code}
          onChangeText={setCode}
        />

        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          onPress={connect}
          disabled={status.kind === "connecting"}
        >
          {status.kind === "connecting" ? (
            <ActivityIndicator color="#0b0b0c" />
          ) : (
            <Text style={styles.buttonText}>{token ? "Re-check" : "Connect"}</Text>
          )}
        </Pressable>

        <Pressable style={styles.ghost} disabled>
          <Text style={styles.ghostText}>Scan QR — coming soon</Text>
        </Pressable>

        <View style={styles.statusRow}>
          {status.kind === "online" && (
            <Text style={styles.online}>
              Yaaay, we’re online.
              {"\n"}
              <Text style={styles.detail}>{status.detail}</Text>
            </Text>
          )}
          {status.kind === "error" && (
            <Text style={styles.errorText}>{status.message}</Text>
          )}
          {status.kind === "idle" && (
            <Text style={styles.detail}>Enter your server + code, then Connect.</Text>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0b0b0c", justifyContent: "center" },
  card: { paddingHorizontal: 28, gap: 8 },
  brand: { color: "#f4f1ea", fontSize: 34, fontWeight: "800", letterSpacing: -1 },
  sub: { color: "#9ca3af", fontSize: 15, marginBottom: 20 },
  label: { color: "#9ca3af", fontSize: 13, marginTop: 12, marginBottom: 6 },
  input: {
    backgroundColor: "#161618",
    color: "#f4f1ea",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#26262a",
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: "#e8743b",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 22,
  },
  buttonPressed: { opacity: 0.85 },
  buttonText: { color: "#0b0b0c", fontSize: 16, fontWeight: "700" },
  ghost: { alignItems: "center", paddingVertical: 12 },
  ghostText: { color: "#6b7280", fontSize: 14 },
  statusRow: { marginTop: 14, minHeight: 48 },
  online: { color: "#4ade80", fontSize: 18, fontWeight: "700", lineHeight: 26 },
  detail: { color: "#9ca3af", fontSize: 13, fontWeight: "400" },
  errorText: { color: "#f87171", fontSize: 14, lineHeight: 20 },
});
