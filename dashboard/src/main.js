import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import AppsList from './views/AppsList.vue';
import AppDetail from './views/AppDetail.vue';
import NewApp from './views/NewApp.vue';
import ConfigureAuth from './views/ConfigureAuth.vue';
import Login from './views/Login.vue';
import Settings from './views/Settings.vue';
import StaticSitesList from './views/StaticSitesList.vue';
import StaticSiteDetail from './views/StaticSiteDetail.vue';
import NewStaticSite from './views/NewStaticSite.vue';
import Containers from './views/Containers.vue';

const routes = [
  { path: '/', component: AppsList },
  { path: '/apps/new', component: NewApp },
  { path: '/apps/:id', component: AppDetail },
  { path: '/static-sites', component: StaticSitesList },
  { path: '/static-sites/new', component: NewStaticSite },
  { path: '/static-sites/:id', component: StaticSiteDetail },
  { path: '/system', component: Containers },
  { path: '/setup', component: ConfigureAuth },
  { path: '/login', component: Login },
  { path: '/settings', component: Settings },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

createApp(App).use(router).mount('#app');
