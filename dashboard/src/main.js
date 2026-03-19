import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import AppsList from './views/AppsList.vue';
import AppDetail from './views/AppDetail.vue';
import NewApp from './views/NewApp.vue';
import ConfigureAuth from './views/ConfigureAuth.vue';

const routes = [
  { path: '/', component: AppsList },
  { path: '/apps/new', component: NewApp },
  { path: '/apps/:id', component: AppDetail },
  { path: '/bootstrap', component: ConfigureAuth },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

createApp(App).use(router).mount('#app');
