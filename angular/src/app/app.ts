// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import {
  Component,
  ElementRef,
  NgZone,
  OnInit,
  ViewChild
} from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { HeaderComponent } from './shared/header/header.component';
import { WizzComponent } from './shared/wizz/wizz.component';
import { GlobalService } from './core/services/global.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Versions } from '../models/versions';
import { ToastrService } from 'ngx-toastr';
import { ConsoleComponent } from './shared/console/console.component';
import { MatDialog } from '@angular/material/dialog';
import { LinuxIntroDialog } from './views/home/dialogs/linux-intro/linux-intro.dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { NotificationService } from './views/notification/services/notification.service';
import { Message } from './views/notification/models/message.model';

//#endregion
@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    HeaderComponent,
    WizzComponent,
    TranslateModule,
    ConsoleComponent,
    MatTooltipModule
  ],
  templateUrl: './app.html',
  styleUrls: ['./app.scss']
})
export class App implements OnInit {
  //#region Attributes

  /** Conteneur principal de la page. */
  @ViewChild('main')
  private readonly main: ElementRef<HTMLElement> | undefined;

  protected versions: Versions | undefined;

  @ViewChild(ConsoleComponent) consoleComponent!: ConsoleComponent;

  //#endregion
  constructor(
    protected readonly globalService: GlobalService,
    private readonly router: Router,
    private readonly ngZone: NgZone,
    private readonly translateService: TranslateService,
    private readonly toastrService: ToastrService,
    private readonly dialogService: MatDialog,
    private readonly notificationService: NotificationService
  ) {}

  //#region Functions

  ngOnInit(): void {
    const SPLITED = globalThis.location.pathname
      .split('/')
      .filter((x) => x && x.trim().length > 0);
    // If the language is not in the URL...
    if (SPLITED.length == 0 || SPLITED[0].length != 2) {
      const URL = `/${this.translateService.getCurrentLang() ?? 'en'}${SPLITED.slice(1).join('/')}`;
      this.router.navigate([URL]);
    }

    // We scroll up each time the user changes pages.
    this.router.events.subscribe((event) => {
      if (this.main) {
        if (event instanceof NavigationEnd) {
          this.main.nativeElement.scrollTo(0, 0);
        }
      }
    });

    // Getting the web server port.
    window.electronAPI
      .getExpressPort()
      .then((server: { port: number; token: string }) => {
        this.ngZone.run(() => {
          this.globalService.serverPort = server.port;
          this.globalService.serverToken = server.token;
        });
      });

    if (SPLITED[1] != 'notification') {
      // Getting the user's operating system.
      window.electronAPI.getOS().then((os: NodeJS.Platform) => {
        this.ngZone.run(() => {
          this.globalService.os = os;

          if (os == 'linux') {
            if (SPLITED[1] != 'notification') {
              this.dialogService.open(LinuxIntroDialog);
            }
          }
        });
      });

      window.electronAPI.isDevMode().then((devMode: boolean) => {
        this.ngZone.run(() => {
          this.globalService.devMode = devMode;
        });
      });

      // Getting the project version.
      window.electronAPI.getVersion().then((versions: Versions) => {
        this.ngZone.run(() => {
          this.versions = new Versions(versions.current, versions.last);
        });
      });

      window.electronAPI.toast(
        (
          type: 'success' | 'error' | 'warning' | 'info',
          i18nPath: string,
          i18nVariables: object
        ) => {
          this.ngZone.run(() => {
            this.translateService
              .get(i18nPath, i18nVariables)
              .subscribe((translated: string) => {
                switch (type) {
                  case 'success':
                    this.toastrService.success(translated);
                    break;
                  case 'error':
                    this.toastrService.error(translated);
                    break;
                  case 'warning':
                    this.toastrService.warning(translated);
                    break;
                  case 'info':
                    this.toastrService.info(translated);
                    break;
                }
              });
          });
        }
      );

      // The server update the notification informations
      window.electronAPI.setNotificationData((message: Message) => {
        this.ngZone.run(() => {
          this.notificationService.sendMessage(message);
        });
      });

      window.electronAPI.globalMessage(
        (i18nPath: string, i18nVariables: object) => {
          this.ngZone.run(() => {
            if (i18nPath) {
              this.translateService
                .get(i18nPath, i18nVariables)
                .subscribe((translated: string) => {
                  this.globalService.loading = translated;
                });
            } else {
              this.globalService.loading = undefined;
            }
          });
        }
      );

    }
  }

  /**
   * Opens the GitHub releases page in the user's default browser to download the latest application update.
   * This method is called when the user clicks on a new update notification link.
   */
  protected onNewUpdateLinkClick(): void {
    window.electronAPI.openURL(
      'https://github.com/HeyHeyChicken/EBP-Tools/releases/latest'
    );
  }

  //#endregion
}
