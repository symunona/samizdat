import { useEffect, useRef, useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { useMemo } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";

type Props = {
    visible: boolean;
    onScan: (data: string) => void;
    onClose: () => void;
};

export function QRScannerModal({ visible, onScan, onClose }: Props) {
    const { theme } = useUnistyles();
    const s = useMemo(() => buildStyles(theme), [theme]);
    const scannedRef = useRef(false);

    useEffect(() => {
        if (visible) scannedRef.current = false;
    }, [visible]);

    if (Platform.OS === "web") {
        return <WebQRScanner visible={visible} onScan={onScan} onClose={onClose} />;
    }

    return (
        <NativeQRScanner
            visible={visible}
            onScan={onScan}
            onClose={onClose}
            scannedRef={scannedRef}
            s={s}
            theme={theme}
        />
    );
}

type NativeProps = Props & {
    scannedRef: React.MutableRefObject<boolean>;
    s: ReturnType<typeof buildStyles>;
    theme: ReturnType<typeof useUnistyles>["theme"];
};

function NativeQRScanner({ visible, onScan, onClose, scannedRef, s, theme }: NativeProps) {
    const [permission, requestPermission] = useCameraPermissions();

    return (
        <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
            <View style={s.container}>
                {!permission?.granted ? (
                    <View style={s.center}>
                        <Text style={s.text}>Camera permission required</Text>
                        <Pressable style={s.btn} onPress={requestPermission}>
                            <Text style={s.btnText}>Grant Permission</Text>
                        </Pressable>
                        <Pressable style={s.ghost} onPress={onClose}>
                            <Text style={[s.btnText, { color: theme.colors.muted }]}>Cancel</Text>
                        </Pressable>
                    </View>
                ) : (
                    <>
                        <CameraView
                            style={StyleSheet.absoluteFill}
                            facing="back"
                            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                            onBarcodeScanned={(result) => {
                                if (scannedRef.current) return;
                                scannedRef.current = true;
                                onScan(result.data);
                            }}
                        />
                        <View style={s.overlay}>
                            <View style={s.frame} />
                            <Text style={s.hint}>Point at the QR code from `sam connect`</Text>
                            <Pressable style={s.btn} onPress={onClose}>
                                <Text style={s.btnText}>Cancel</Text>
                            </Pressable>
                        </View>
                    </>
                )}
            </View>
        </Modal>
    );
}

function WebQRScanner({ visible, onScan, onClose }: Props) {
    const { theme } = useUnistyles();
    const s = useMemo(() => buildStyles(theme), [theme]);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const rafRef = useRef<number | null>(null);
    const scannedRef = useRef(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!visible) {
            stopStream();
            return;
        }
        scannedRef.current = false;
        setError(null);
        startStream();
        return () => stopStream();
    }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

    function stopStream() {
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
    }

    async function startStream() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "environment" },
            });
            streamRef.current = stream;
            if (!videoRef.current) return;
            videoRef.current.srcObject = stream;
            await videoRef.current.play();
            scheduleScan();
        } catch {
            setError("Could not access camera");
        }
    }

    function scheduleScan() {
        rafRef.current = requestAnimationFrame(async () => {
            if (scannedRef.current || !videoRef.current) return;
            const video = videoRef.current;
            if (video.readyState < 2) { scheduleScan(); return; }

            try {
                // @ts-expect-error BarcodeDetector not in TS lib yet
                const detector = new BarcodeDetector({ formats: ["qr_code"] });
                const codes = await detector.detect(video);
                if (codes.length > 0 && !scannedRef.current) {
                    scannedRef.current = true;
                    onScan(codes[0].rawValue);
                    return;
                }
            } catch { /* BarcodeDetector not available */ }
            scheduleScan();
        });
    }

    if (!visible) return null;

    return (
        <View style={StyleSheet.absoluteFill as object}>
            <View style={[s.container, { position: "fixed" as "absolute" }]}>
                {error ? (
                    <View style={s.center}>
                        <Text style={s.text}>{error}</Text>
                        <Pressable style={s.btn} onPress={onClose}>
                            <Text style={s.btnText}>Close</Text>
                        </Pressable>
                    </View>
                ) : (
                    <>
                        <video
                            ref={videoRef}
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                            playsInline
                            muted
                        />
                        <View style={s.overlay}>
                            <View style={s.frame} />
                            <Text style={s.hint}>Point at the QR code from `sam connect`</Text>
                            <Pressable style={s.btn} onPress={onClose}>
                                <Text style={s.btnText}>Cancel</Text>
                            </Pressable>
                        </View>
                    </>
                )}
            </View>
        </View>
    );
}

type Theme = ReturnType<typeof useUnistyles>["theme"];

function buildStyles(t: Theme) {
    return StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: "#000",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
        },
        center: {
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            padding: 32,
        },
        overlay: {
            position: "absolute",
            bottom: 60,
            left: 0,
            right: 0,
            alignItems: "center",
            gap: 16,
            paddingHorizontal: 32,
        },
        frame: {
            width: 240,
            height: 240,
            borderWidth: 2,
            borderColor: "#fff",
            borderRadius: 12,
            marginBottom: 24,
        },
        text: { color: "#fff", fontSize: 16, textAlign: "center" },
        hint: { color: "rgba(255,255,255,0.8)", fontSize: 13, textAlign: "center" },
        btn: {
            backgroundColor: t.colors.accent,
            borderRadius: t.radius.md,
            paddingVertical: 12,
            paddingHorizontal: 32,
        },
        btnText: { color: t.colors.background, fontSize: 15, fontWeight: "700" },
        ghost: { paddingVertical: 12 },
    });
}
