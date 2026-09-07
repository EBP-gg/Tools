// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

// Capture du son d'UN processus, via l'API Application Loopback de Windows
// (build 20348+). Le flux est prélevé sur l'application elle-même et non sur
// le périphérique de sortie : il ne suit donc ni le volume master, ni le
// mélangeur de volume, ni le mute. C'est l'exigence du mode salle — ce qui
// est enregistré ne doit pas dépendre des curseurs de l'opérateur — et c'est
// précisément ce que ce banc doit VALIDER avant qu'on investisse dans
// l'intégration.
//
//   audio_loopback.exe --list
//       Liste les applications avec fenêtre, sur stdout : pid<TAB>titre<TAB>exe
//
//   audio_loopback.exe <pid | texte> [--quiet]
//       stdout : PCM brut s16le 48 kHz stéréo (destiné à ffmpeg)
//       stderr : diagnostics + niveau RMS chaque seconde, sauf avec --quiet
//       <texte> est cherché dans le titre de fenêtre puis dans le nom d'exe,
//       sans tenir compte de la casse (ex. "After-H").

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <tlhelp32.h>
#include <objbase.h>
#include <stdio.h>
#include <stdlib.h>
#include <wctype.h>
#include <io.h>
#include <fcntl.h>
#include <math.h>
#include <string>
#include <vector>

//#region Constantes

// Format imposé au loopback : le mode process n'a pas de format de mix à
// négocier, on choisit celui que ffmpeg consommera tel quel (-f s16le).
static const WORD CHANNELS = 2;
static const DWORD SAMPLE_RATE = 48000;
static const WORD BITS_PER_SAMPLE = 16;

// Tampon de 200 ms : assez large pour absorber un coup de charge sur le PC de
// salle sans perdre de paquets, assez court pour ne pas ajouter de latence
// visible dans la mesure de niveau.
static const REFERENCE_TIME BUFFER_DURATION_HNS = 2000000;

// Période d'affichage du niveau sur stderr.
static const DWORD LEVEL_INTERVAL_MS = 1000;

//#endregion

static volatile BOOL g_running = TRUE;

static BOOL WINAPI onConsoleCtrl(DWORD type) {
    (void)type;
    // Arrêt propre : la boucle sort, le client audio est stoppé et libéré.
    g_running = FALSE;
    return TRUE;
}

//#region Énumération des applications

struct AppEntry {
    DWORD pid;
    std::wstring title;
    std::wstring exe;
};

static std::wstring exeNameForPid(DWORD pid) {
    std::wstring name;
    HANDLE SNAP = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (SNAP == INVALID_HANDLE_VALUE) return name;
    PROCESSENTRY32W ENTRY = {};
    ENTRY.dwSize = sizeof(ENTRY);
    if (Process32FirstW(SNAP, &ENTRY)) {
        do {
            if (ENTRY.th32ProcessID == pid) {
                name = ENTRY.szExeFile;
                break;
            }
        } while (Process32NextW(SNAP, &ENTRY));
    }
    CloseHandle(SNAP);
    return name;
}

static BOOL CALLBACK onWindow(HWND hwnd, LPARAM param) {
    std::vector<AppEntry>* out = reinterpret_cast<std::vector<AppEntry>*>(param);
    // Fenêtres principales visibles uniquement : c'est la liste que
    // l'utilisateur reconnaît dans sa barre des tâches, pas les centaines de
    // processus système d'un snapshot brut.
    if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER) != nullptr) return TRUE;
    int LENGTH = GetWindowTextLengthW(hwnd);
    if (LENGTH <= 0) return TRUE;
    std::wstring title(static_cast<size_t>(LENGTH) + 1, L'\0');
    GetWindowTextW(hwnd, &title[0], LENGTH + 1);
    title.resize(static_cast<size_t>(LENGTH));

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0) return TRUE;
    // Une application peut avoir plusieurs fenêtres : un seul PID suffit.
    for (size_t i = 0; i < out->size(); i++) {
        if ((*out)[i].pid == pid) return TRUE;
    }
    AppEntry entry;
    entry.pid = pid;
    entry.title = title;
    entry.exe = exeNameForPid(pid);
    out->push_back(entry);
    return TRUE;
}

static std::vector<AppEntry> listApps() {
    std::vector<AppEntry> apps;
    EnumWindows(onWindow, reinterpret_cast<LPARAM>(&apps));
    return apps;
}

static std::wstring toLower(const std::wstring& value) {
    std::wstring out = value;
    for (size_t i = 0; i < out.size(); i++) out[i] = towlower(out[i]);
    return out;
}

/** PID direct si l'argument est numérique, sinon recherche titre puis exe. */
static DWORD resolvePid(const wchar_t* argument) {
    wchar_t* end = nullptr;
    unsigned long numeric = wcstoul(argument, &end, 10);
    if (end && *end == L'\0' && numeric > 0) return static_cast<DWORD>(numeric);

    const std::wstring NEEDLE = toLower(argument);
    std::vector<AppEntry> apps = listApps();
    for (size_t i = 0; i < apps.size(); i++) {
        if (toLower(apps[i].title).find(NEEDLE) != std::wstring::npos) return apps[i].pid;
    }
    for (size_t i = 0; i < apps.size(); i++) {
        if (toLower(apps[i].exe).find(NEEDLE) != std::wstring::npos) return apps[i].pid;
    }
    return 0;
}

//#endregion

//#region Activation asynchrone du client audio

// ActivateAudioInterfaceAsync ne rend pas le client directement : il rappelle
// ce handler, qu'on attend sur un événement. L'objet vit sur la pile de wmain
// et survit à tout l'appel, d'où le comptage de références factice.
class ActivationHandler : public IActivateAudioInterfaceCompletionHandler,
                          public IAgileObject {
public:
    HANDLE done;
    HRESULT result;
    IAudioClient* client;

    ActivationHandler() : done(CreateEventW(nullptr, TRUE, FALSE, nullptr)),
                          result(E_UNEXPECTED),
                          client(nullptr) {}

    ~ActivationHandler() {
        if (done) CloseHandle(done);
    }

    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) {
        HRESULT activation = S_OK;
        IUnknown* unknown = nullptr;
        HRESULT hr = operation->GetActivateResult(&activation, &unknown);
        if (SUCCEEDED(hr)) hr = activation;
        if (SUCCEEDED(hr) && unknown) {
            hr = unknown->QueryInterface(__uuidof(IAudioClient),
                                         reinterpret_cast<void**>(&client));
        }
        if (unknown) unknown->Release();
        result = hr;
        SetEvent(done);
        return S_OK;
    }

    STDMETHOD(QueryInterface)(REFIID riid, void** ppv) {
        if (!ppv) return E_POINTER;
        if (riid == __uuidof(IUnknown) ||
            riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        } else if (riid == __uuidof(IAgileObject)) {
            *ppv = static_cast<IAgileObject*>(this);
        } else {
            *ppv = nullptr;
            return E_NOINTERFACE;
        }
        return S_OK;
    }
    STDMETHOD_(ULONG, AddRef)() { return 1; }
    STDMETHOD_(ULONG, Release)() { return 1; }
};

//#endregion

#define CHECK(hr, what)                                                        \
    if (FAILED(hr)) {                                                          \
        fwprintf(stderr, L"[error] %s (hr=0x%08X)\n", what,                    \
                 static_cast<unsigned>(hr));                                   \
        return 1;                                                              \
    }

static void printUsage() {
    fwprintf(stderr, L"usage: audio_loopback.exe --list\n");
    fwprintf(stderr, L"       audio_loopback.exe <pid|texte> [--quiet]\n");
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 2) {
        printUsage();
        return 2;
    }

    if (wcscmp(argv[1], L"--list") == 0) {
        // UTF-8 explicite : les titres de fenetre contiennent des accents, et
        // c'est ce flux que le service Electron parsera plus tard. Sans danger
        // ici, ce mode ne produit jamais de PCM.
        _setmode(_fileno(stdout), _O_U8TEXT);
        std::vector<AppEntry> apps = listApps();
        for (size_t i = 0; i < apps.size(); i++) {
            wprintf(L"%lu\t%s\t%s\n", apps[i].pid, apps[i].title.c_str(),
                    apps[i].exe.c_str());
        }
        return 0;
    }

    BOOL quiet = FALSE;
    for (int i = 2; i < argc; i++) {
        if (wcscmp(argv[i], L"--quiet") == 0) quiet = TRUE;
    }

    const DWORD PID = resolvePid(argv[1]);
    if (PID == 0) {
        fwprintf(stderr, L"[error] aucune application ne correspond a \"%s\"\n",
                 argv[1]);
        return 2;
    }
    fwprintf(stderr, L"[info] capture du pid %lu (%s)\n", PID,
             exeNameForPid(PID).c_str());

    // Poignée sur le processus ciblé. Elle désigne l'OBJET NOYAU et non le
    // numéro : Windows réattribue les pid, et un superviseur qui se contenterait
    // de tester l'existence du numéro finirait par croire le jeu vivant alors
    // qu'un autre programme en a hérité. La poignée passe à l'état signalé à la
    // mort du processus, et c'est ce qui nous fait sortir proprement — sans quoi
    // ce helper resterait activé sur un processus disparu, sans plus jamais
    // produire d'échantillon, et plus aucune game ne serait sonorisée.
    HANDLE TARGET = OpenProcess(SYNCHRONIZE, FALSE, PID);
    if (!TARGET) {
        fwprintf(stderr,
                 L"[warn] surveillance du processus indisponible (err %lu)\n",
                 GetLastError());
    }

    // stdout en binaire : sans ca le CRT traduirait 0x0A en 0x0D0A et
    // corromprait le PCM.
    _setmode(_fileno(stdout), _O_BINARY);
    SetConsoleCtrlHandler(onConsoleCtrl, TRUE);

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    CHECK(hr, L"CoInitializeEx");

    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = PID;
    // INCLUDE_TARGET_PROCESS_TREE : beaucoup d'applications rendent leur son
    // depuis un processus enfant (moteur audio separe). Cibler le seul PID
    // parent ramenerait du silence.
    params.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT activation = {};
    activation.vt = VT_BLOB;
    activation.blob.cbSize = sizeof(params);
    activation.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    ActivationHandler handler;
    IActivateAudioInterfaceAsyncOperation* operation = nullptr;
    hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                     __uuidof(IAudioClient), &activation,
                                     &handler, &operation);
    CHECK(hr, L"ActivateAudioInterfaceAsync");
    if (operation) operation->Release();

    WaitForSingleObject(handler.done, INFINITE);
    CHECK(handler.result, L"activation du client (Windows 10 build 20348+ requis)");
    IAudioClient* CLIENT = handler.client;

    WAVEFORMATEX format = {};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = CHANNELS;
    format.nSamplesPerSec = SAMPLE_RATE;
    format.wBitsPerSample = BITS_PER_SAMPLE;
    format.nBlockAlign = static_cast<WORD>(CHANNELS * BITS_PER_SAMPLE / 8);
    format.nAvgBytesPerSec = SAMPLE_RATE * format.nBlockAlign;
    format.cbSize = 0;

    hr = CLIENT->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_LOOPBACK |
                                AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                            BUFFER_DURATION_HNS, 0, &format, nullptr);
    CHECK(hr, L"IAudioClient::Initialize");

    HANDLE READY = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    hr = CLIENT->SetEventHandle(READY);
    CHECK(hr, L"IAudioClient::SetEventHandle");

    IAudioCaptureClient* capture = nullptr;
    hr = CLIENT->GetService(__uuidof(IAudioCaptureClient),
                            reinterpret_cast<void**>(&capture));
    CHECK(hr, L"IAudioClient::GetService");

    hr = CLIENT->Start();
    CHECK(hr, L"IAudioClient::Start");
    fwprintf(stderr, L"[info] capture demarree — Ctrl+C pour arreter\n");

    double squares = 0.0;
    unsigned long long sampleCount = 0;
    DWORD lastLevel = GetTickCount();
    // Tampon de zeros pour les paquets marques silencieux : leur contenu n'est
    // pas garanti, mais le flux doit rester continu pour ffmpeg.
    std::vector<BYTE> silence;

    while (g_running) {
        WaitForSingleObject(READY, 200);

        for (;;) {
            UINT32 packetFrames = 0;
            hr = capture->GetNextPacketSize(&packetFrames);
            if (FAILED(hr) || packetFrames == 0) break;

            BYTE* data = nullptr;
            UINT32 frames = 0;
            DWORD flags = 0;
            hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
            if (FAILED(hr)) break;

            const size_t BYTES = static_cast<size_t>(frames) * format.nBlockAlign;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                if (silence.size() < BYTES) silence.resize(BYTES, 0);
                fwrite(silence.data(), 1, BYTES, stdout);
                sampleCount += static_cast<unsigned long long>(frames) * CHANNELS;
            } else {
                fwrite(data, 1, BYTES, stdout);
                const short* SAMPLES = reinterpret_cast<const short*>(data);
                const size_t COUNT = static_cast<size_t>(frames) * CHANNELS;
                for (size_t i = 0; i < COUNT; i++) {
                    const double VALUE = SAMPLES[i] / 32768.0;
                    squares += VALUE * VALUE;
                }
                sampleCount += COUNT;
            }
            capture->ReleaseBuffer(frames);
        }
        fflush(stdout);

        // Le niveau est affiche sur l'horloge murale, meme quand aucun paquet
        // n'arrive : une application muette doit se lire "-inf", pas se
        // traduire par une absence de ligne qu'on confondrait avec un blocage.
        const DWORD NOW = GetTickCount();
        if (!quiet && NOW - lastLevel >= LEVEL_INTERVAL_MS) {
            if (sampleCount == 0) {
                fwprintf(stderr, L"[level] -inf dBFS (aucun echantillon)\n");
            } else {
                const double RMS = sqrt(squares / static_cast<double>(sampleCount));
                if (RMS <= 0.0) {
                    fwprintf(stderr, L"[level] -inf dBFS\n");
                } else {
                    fwprintf(stderr, L"[level] %.1f dBFS\n", 20.0 * log10(RMS));
                }
            }
            fflush(stderr);
            squares = 0.0;
            sampleCount = 0;
            lastLevel = NOW;
        }

        // Testé APRÈS la vidange des paquets : la fin du jeu ne doit pas nous
        // faire perdre le son déjà mis en tampon.
        if (TARGET && WaitForSingleObject(TARGET, 0) == WAIT_OBJECT_0) {
            fwprintf(stderr, L"[info] processus cible termine\n");
            break;
        }
    }

    if (TARGET) CloseHandle(TARGET);
    CLIENT->Stop();
    capture->Release();
    CLIENT->Release();
    CloseHandle(READY);
    CoUninitialize();
    fwprintf(stderr, L"[info] arret\n");
    return 0;
}
