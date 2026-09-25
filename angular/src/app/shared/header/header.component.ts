// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Import

import { Component, NgZone, OnInit } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Location as CommonLocation } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectChange, MatSelectModule } from '@angular/material/select';
import { GlobalService } from '../../core/services/global.service';
import { MatTooltipModule } from '@angular/material/tooltip';

//#endregion

@Component({
  selector: 'ebp-header',
  templateUrl: './header.component.html',
  styleUrls: ['./header.component.scss'],
  standalone: true,
  imports: [
    FormsModule,
    TranslateModule,
    MatFormFieldModule,
    MatSelectModule,
    MatTooltipModule,
    RouterModule
  ]
})
export class HeaderComponent implements OnInit {
  //#region Attributes

  protected readonly pages: string[] = [
    'replay_downloader',
    'replay_cutter',
    'arena_mode'
  ];
  protected page?: string;

  private static STORAGE_KEY_NAME: string = 'language';
  private static DEFAULT_LANGUAGE: string = 'en';

  //#endregion

  constructor(
    protected readonly commonLocation: CommonLocation,
    protected readonly router: Router,
    protected readonly translateService: TranslateService,
    protected readonly globalService: GlobalService,
    private readonly ngZone: NgZone
  ) {}

  //#region Functions

  ngOnInit(): void {
    // In arena mode, the tool selector is locked on the arena mode page.
    window.electronAPI?.arenaModeGetState().then((state) => {
      this.ngZone.run(() => {
        this.globalService.arenaModeRegistered = state.registered;
        if (state.registered) {
          this.page = 'arena_mode';
        }
      });
    });

    // List of languages supported by the application.
    this.translateService.addLangs(
      ['fr', 'de', 'en', 'es', 'it', 'ro', 'pt'].sort()
    );

    this.translateService.setFallbackLang(HeaderComponent.DEFAULT_LANGUAGE);

    const LANGUAGE = location.pathname.split('/').filter((x) => x != '')[0];
    if (this.translateService.getLangs().includes(LANGUAGE)) {
      this.setLanguage(LANGUAGE);
    } else {
      const STORED_LANGUAGE = localStorage.getItem(
        HeaderComponent.STORAGE_KEY_NAME
      );
      if (STORED_LANGUAGE) {
        this.setLanguage(STORED_LANGUAGE);
      } else {
        const BROWSER_LANGUAGE: string = navigator.language;
        this.setLanguage(
          this.translateService.getLangs().includes(BROWSER_LANGUAGE)
            ? BROWSER_LANGUAGE
            : HeaderComponent.DEFAULT_LANGUAGE
        );
      }
    }
  }

  /**
   * This function opens a URL in the user's default browser.
   * @param url URL to open in the user's default browser.
   */
  protected openURLExternalBrowser(url: string): void {
    window.electronAPI.openURL(url);
  }

  /**
   * This function runs when the user changes the language of the website.
   * @param event “onchange” event.
   */
  protected languageSelectChanged(event: Event): void {
    if (event.target) {
      const SELECT = event.target as HTMLSelectElement;
      this.setLanguage(SELECT.value);
    }
  }

  /**
   * Handles tool selection changes by navigating to the route corresponding to the selected tool and the current language.
   * @param event Selection change event from a MatSelect component.
   */
  protected changeTool(event: MatSelectChange): void {
    this.router.navigate([
      `/${this.translateService.getCurrentLang()}/${event.value}`
    ]);
  }

  /**
   * This function allows you to change the language of the website.
   * @param language Language to apply.
   */
  private setLanguage(language: string): void {
    const LANGUAGE: string = language.toLowerCase();
    this.translateService.use(LANGUAGE);
    localStorage.setItem(HeaderComponent.STORAGE_KEY_NAME, LANGUAGE);
    window.electronAPI?.setLanguage(LANGUAGE);

    // We change the language in the URL.
    const CURRENT_PATH = this.commonLocation.path(); // Current path
    let newPath = CURRENT_PATH.replace(/^\/[a-z]{2}/, `/${LANGUAGE}`); // Replace language in URL
    if (newPath.length == 0) {
      newPath = `/${LANGUAGE}`;
    }
    this.commonLocation.replaceState(newPath);
  }

  //#endregion
}
