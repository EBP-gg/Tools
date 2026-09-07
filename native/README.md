# audio_loopback — banc de validation

Capture le son d'**une** application via l'API Application Loopback de Windows.
Contrairement au loopback classique sur le périphérique de sortie, le flux est
prélevé sur l'application elle-même : il ne devrait dépendre ni du volume
master, ni du mélangeur de volume, ni du mute.

**C'est exactement ce que ce banc doit vérifier.** Le mode salle exige que
l'audio enregistré ne suive pas les curseurs de l'opérateur. Si le test 2
ci-dessous échoue, l'API ne tient pas sa promesse et l'architecture audio du
mode salle est à revoir avant toute intégration.

## Prérequis

- Windows 10 build 20348 ou plus récent (Windows 11 inclus). Sur plus ancien,
  l'activation du client échoue avec un message explicite.
- Visual Studio 2022 + Windows SDK 10.0.20348 ou plus récent.

## Compilation

Dans une « x64 Native Tools Command Prompt for VS 2022 », depuis `native\` :

```
build.bat
```

Le binaire est déposé dans `..\binaries\audio-loopback\win32.exe`.

## Utilisation

```
win32.exe --list                  liste des applications : pid<TAB>titre<TAB>exe
win32.exe "After-H"               capture (texte cherché dans le titre puis l'exe)
win32.exe 1234                    capture par PID
win32.exe "After-H" --quiet       sans l'affichage du niveau
```

- **stdout** : PCM brut s16le, 48 kHz, stéréo — destiné à être pipé dans ffmpeg.
- **stderr** : diagnostics et niveau RMS en dBFS, une ligne par seconde.

Ctrl+C arrête proprement.

## Protocole de validation

Lancer After-H avec du son, puis `win32.exe "After-H"` et **regarder les lignes
`[level]`** pendant chaque manipulation.

1. **Référence** — le niveau doit bouger avec le son du jeu. S'il reste à
   `-inf` alors qu'on entend le jeu, le son vient probablement d'un processus
   hors de l'arbre ciblé : relancer avec le PID du processus qui joue réellement.
2. **Volume master** — passer le curseur de la barre des tâches de 100 % à 20 %.
   **Le niveau ne doit pas bouger.** C'est le test décisif.
3. **Mute** — couper le son depuis la barre des tâches. Le niveau ne doit pas
   bouger non plus.
4. **Mélangeur de volume** — mettre After-H à 20 % dans le mélangeur Windows.
   Le niveau ne doit pas bouger.
5. **Autre application** — lancer une musique dans un navigateur. Le niveau ne
   doit **pas** réagir : on ne capte qu'After-H.
6. **Périphérique de sortie** — changer la sortie par défaut de Windows pendant
   la capture (HP du PC ↔ écran HDMI ↔ casque). Le niveau ne doit pas bouger.
   Chaque sortie HDMI est un point de terminaison audio distinct : le loopback
   classique ne capte que la sortie par défaut et devient muet dès que le jeu
   rend son son ailleurs. C'est le défaut observé en salle, et l'activation sur
   `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` doit précisément l'éliminer.

Vérification d'écoute, une fois les niveaux validés — enregistrer 10 secondes en
WAV et le relire :

```
win32.exe "After-H" --quiet | ffmpeg -f s16le -ar 48000 -ac 2 -i - -t 10 test.wav
```

`ffmpeg` est disponible dans `..\binaries\ffmpeg\win32.exe`.
