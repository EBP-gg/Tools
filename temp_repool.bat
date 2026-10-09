@echo off
setlocal
REM ============================================================================
REM Rejoue une video de soiree dans le spool du mode salle : decoupe en segments
REM de 5 min nommes comme la captation reelle (rec_AAAAMMJJ-HHMMSS.mkv, heure
REM LOCALE de la machine).
REM
REM   temp_repool.bat <video> ["AAAA-MM-JJ HH:MM:SS"] [spool]
REM
REM <video>  chemin complet OU simple nom de fichier s'il est deja dans le spool.
REM <ancre>  heure d'horloge de la PREMIERE IMAGE de la video (pas celle de la
REM          1re game). Accepte "HH:MM:SS" et "HH-MM-SS". Omise, elle est lue
REM          dans le nom du fichier (nommage OBS "AAAA-MM-JJ HH-MM-SS.mkv").
REM          Elle doit etre precise, sinon
REM          /arena/games/resolve ne retrouvera pas les games.
REM
REM Pourquoi pas -strftime : il nomme les segments avec l'heure COURANTE, pas
REM l'heure video. Un stream-copy durant quelques secondes, tous les segments
REM porteraient la meme minute.
REM
REM Les dates sont calculees par UN SEUL appel PowerShell qui produit la liste
REM complete "ancien|nouveau" ; le batch ne fait ensuite que deplacer. Les
REM valeurs sont passees par VARIABLES D'ENVIRONNEMENT, pas par interpolation
REM dans la ligne de commande : aucun probleme d'echappement possible.
REM ============================================================================

if "%~1"=="" (
    echo usage: temp_repool.bat ^<video^> ["AAAA-MM-JJ HH:MM:SS"] [spool]
    exit /b 1
)

set "SRC=%~1"
set "BASE_LOCAL=%~2"
set "SPOOL=%~3"
if "%SPOOL%"=="" set "SPOOL=%USERPROFILE%\EBP-Tools-Arena\spool"
set "SEGMENT_SECONDS=300"

REM ffmpeg embarque du repo (meme binaire que celui utilise par Tools).
set "FFMPEG=%~dp0binaries\ffmpeg\win32.exe"
if not exist "%FFMPEG%" set "FFMPEG=ffmpeg"

REM Video donnee par son seul nom : on la cherche dans le spool de destination,
REM puis dans le spool par defaut — la destination peut etre un dossier d'essai
REM alors que la video, elle, est dans le vrai spool.
if not exist "%SRC%" if exist "%SPOOL%\%SRC%" set "SRC=%SPOOL%\%SRC%"
if not exist "%SRC%" if exist "%USERPROFILE%\EBP-Tools-Arena\spool\%SRC%" set "SRC=%USERPROFILE%\EBP-Tools-Arena\spool\%SRC%"
if not exist "%SRC%" (
    echo !! Video introuvable : %SRC%
    exit /b 1
)

REM Ancre omise : on la lit dans le nom du fichier (nommage OBS).
if "%BASE_LOCAL%"=="" (
    for %%f in ("%SRC%") do set "BASE_LOCAL=%%~nf"
    echo == Ancre deduite du nom du fichier.
)

REM --- 1. Controles prealables ------------------------------------------------
echo == Source : %SRC%
"%FFMPEG%" -hide_banner -i "%SRC%" 2>&1 | findstr /C:"Duration" /C:"Video:"

"%FFMPEG%" -hide_banner -i "%SRC%" 2>&1 | findstr /C:"1920x1080" >nul
if errorlevel 1 (
    echo.
    echo !! La source n'est pas en 1920x1080. L'analyseur travaille en
    echo !! coordonnees 1080p ABSOLUES : la detection echouerait. Abandon.
    exit /b 1
)

REM Validation de l'ancre AVANT tout traitement : c'est le seul reglage que
REM l'utilisateur peut se tromper, et une ancre invalide doit arreter le script
REM tout de suite, pas au milieu du renommage.
set "PS_PARSE=[datetime]::ParseExact($env:BASE_LOCAL.Trim(), [string[]]@('yyyy-MM-dd HH:mm:ss','yyyy-MM-dd HH-mm-ss'), [cultureinfo]::InvariantCulture, 0)"
set "ANCHOR="
for /f "usebackq delims=" %%d in (`powershell -NoProfile -Command "try { (%PS_PARSE%).ToString('yyyy-MM-dd HH:mm:ss') } catch { '' }"`) do set "ANCHOR=%%d"
if "%ANCHOR%"=="" (
    echo.
    echo !! Ancre illisible : "%BASE_LOCAL%"
    echo !! Formats acceptes : "AAAA-MM-JJ HH:MM:SS" ou "AAAA-MM-JJ HH-MM-SS".
    exit /b 1
)
echo == Ancre : %ANCHOR%

REM --- 2. Decoupe stream-copy + liste des offsets reels -----------------------
set "WORK=%TEMP%\repool_%RANDOM%%RANDOM%"
mkdir "%WORK%" || exit /b 1

echo == Decoupe en segments de %SEGMENT_SECONDS%s (stream-copy)...
"%FFMPEG%" -hide_banner -v error -i "%SRC%" -c copy -f segment ^
    -segment_time %SEGMENT_SECONDS% -reset_timestamps 1 ^
    -segment_list "%WORK%\list.csv" -segment_list_type csv ^
    "%WORK%\part_%%03d.mkv"
if errorlevel 1 (
    echo !! ffmpeg a echoue.
    rd /s /q "%WORK%"
    exit /b 1
)

REM --- 3. Calcul de TOUS les noms en un appel ---------------------------------
REM En stream-copy les coupes tombent sur les keyframes : les segments ne font
REM pas exactement 300 s. On lit donc le start REEL de chaque segment (colonne 2
REM du CSV) plutot que i x 300.
set "LIST=%WORK%\list.csv"
set "PAIRS=%WORK%\pairs.txt"
powershell -NoProfile -Command "$b = %PS_PARSE%; Import-Csv $env:LIST -Header f,start,end | ForEach-Object { (Split-Path $_.f -Leaf) + '|rec_' + $b.AddSeconds([int][double]$_.start).ToString('yyyyMMdd-HHmmss') + '.mkv' }" > "%PAIRS%"

REM Aucun nom calcule = on ne touche a rien (c'est ce qui a produit des
REM "rec_.mkv" ecrases les uns par les autres dans la version precedente).
for /f %%c in ('type "%PAIRS%" ^| find /c "rec_"') do set "NB=%%c"
if "%NB%"=="0" (
    echo !! Calcul des noms echoue : aucun fichier deplace.
    rd /s /q "%WORK%"
    exit /b 1
)

REM --- 4. Deplacement dans le spool -------------------------------------------
if not exist "%SPOOL%" mkdir "%SPOOL%"
echo == %NB% segment(s) ecrit(s) dans %SPOOL% :
for /f "usebackq tokens=1,2 delims=|" %%a in ("%PAIRS%") do (
    if exist "%WORK%\%%a" (
        move "%WORK%\%%a" "%SPOOL%\%%b" >nul
        echo    %%b
    ) else (
        echo    !! segment manquant : %%a
    )
)

rd /s /q "%WORK%"
echo.
echo == Pret. Demarre Tools (mode salle enregistre) : le pipeline lance un round
echo    immediatement. La video source reste dans le spool mais est IGNOREE par
echo    le pipeline (son nom ne correspond pas a rec_*.mkv) : tu peux la
echo    supprimer, elle occupe juste de la place.
exit /b 0
