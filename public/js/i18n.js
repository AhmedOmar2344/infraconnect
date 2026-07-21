/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  InfraConnect — i18n / Language Switcher Engine
 *  File: public/js/i18n.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Include this script on any page (after cart.js if that page uses it) to
 *  get: a language toggle button, RTL layout switching, an Arabic font, and
 *  translation of every element tagged with data-i18n / data-i18n-html /
 *  data-i18n-placeholder.
 *
 *  For DYNAMIC content (product names, category names, site settings text
 *  that come from the database with parallel _ar fields), use localized():
 *
 *    localized(product, 'name')   → product.name_ar if Arabic + present,
 *                                    else product.name
 *
 *  USAGE ON A PAGE:
 *    <script src="/js/i18n.js"></script>
 *    ...tag any static text you want translated:
 *    <a data-i18n="nav_home" href="/">Home</a>
 * ═══════════════════════════════════════════════════════════════════════════
 */

const IC_LANG_KEY = 'ic_lang';

/* ── Translation dictionary — static UI strings ─────────────────────────── */
const IC_I18N = {
  en: {
    // Navbar
    nav_home: 'Home', nav_about: 'About', nav_services: 'Services', nav_store: 'Store',
    nav_projects: 'Projects', nav_contact: 'Contact', nav_request_service: 'Request Service',
    nav_get_in_touch: 'Get in Touch', nav_admin: 'Admin',
    // Common buttons / actions
    btn_add_to_cart: 'Add to Cart', btn_add: 'Add', btn_view_details: 'Details', btn_view_cart: 'View Cart',
    btn_checkout: 'Checkout', btn_send_message: 'Send Message', btn_submit: 'Submit',
    btn_browse_products: 'Browse Products', btn_learn_more: 'Learn More', btn_clear_filters: 'Clear Filters',
    btn_request_quote: 'Request Quote', btn_buy_now: 'Buy Now', btn_place_order: 'Place Order', btn_continue_shopping: 'Continue Shopping',
    btn_back: 'Back', btn_search: 'Search',
    // Store / product
    store_all_categories: 'All Categories', store_search_placeholder: 'Search products…',
    store_no_products: 'No products found', store_price_on_request: 'Price on Request',
    out_of_stock: 'Out of Stock', only_x_left: 'Only {n} left!',
    reviews_title: 'Customer Reviews', reviews_loading: 'Loading reviews...',
    btn_write_review: 'Write a Review', reviews_write_title: 'Share your experience',
    reviews_your_rating: 'Your Rating', reviews_email_optional: 'Email (optional, not shown publicly)',
    reviews_your_comment: 'Your Review', btn_submit_review: 'Submit Review', btn_cancel: 'Cancel',
    reviews_one: 'review', reviews_many: 'reviews', reviews_none_yet: 'No reviews yet — be the first!',
    store_related_products: 'Related Products', store_specifications: 'Specifications',
    store_brand: 'Brand', store_category: 'Category',
    // Cart / checkout
    cart_title: 'Shopping Cart', cart_empty: 'Your cart is empty', cart_subtotal: 'Subtotal',
    cart_total: 'Total', cart_quantity: 'Quantity', cart_remove: 'Remove',
    checkout_title: 'Checkout', checkout_your_details: 'Your Details',
    checkout_first_name: 'First Name', checkout_last_name: 'Last Name',
    checkout_email: 'Email', checkout_phone: 'Phone', checkout_company: 'Company (optional)',
    checkout_notes: 'Additional Notes (optional)',
    // Forms (contact / quote / service request)
    form_first_name: 'First Name', form_last_name: 'Last Name', form_email: 'Email',
    form_phone: 'Phone', form_company: 'Company', form_message: 'Message',
    form_service_needed: 'Service Needed', form_send_us_message: 'Send Us a Message',
    // Footer
    footer_quick_links: 'Quick Links', footer_contact_us: 'Contact Us', footer_follow_us: 'Follow Us',
    // Admin panel — sidebar & topbar
    admin_sec_overview: 'Overview', admin_sec_website: 'Website Content', admin_sec_store: 'Store',
    admin_sec_crm: 'CRM', admin_sec_settings: 'Settings',
    admin_dashboard: 'Dashboard', admin_analytics: 'Analytics', admin_site_editor: 'Site Editor', admin_pages: 'Pages',
    admin_navigation: 'Navigation', admin_media: 'Media & Logos', admin_ai_creator: '✨ AI Product Creator',
    admin_products: 'Products', admin_categories: 'Categories', admin_reviews: 'Reviews & Ratings', admin_vouchers: 'Vouchers & Discounts', admin_service_requests: 'Service Requests',
    admin_messages: 'Messages', admin_quotes: 'Quotes', admin_orders: 'Orders', admin_chat: 'Chat Support', admin_customers: 'Customers', admin_refunds: 'Refund Requests', admin_couriers: 'Couriers',
    admin_company_info: 'Company Info', admin_seo_settings: 'SEO Settings', admin_users: 'Admin Users', admin_api_console: 'API Console', admin_activity_log: 'Activity Log',
    admin_sign_out: 'Sign Out', admin_view_website: '↗ View Website', admin_view_store: '↗ View Store',
    // Home page
    home_hero_tag: 'IT Infrastructure Experts — Cairo, Egypt',
    home_hero_title_html: 'Building <em>Future-Ready</em> IT Infrastructure',
    home_hero_sub: 'InfraConnect delivers high-performance IT infrastructure, cloud services, and managed IT support for businesses that refuse to stand still.',
    stat_founded: 'Founded', stat_key_projects: 'Key Projects', stat_it_support: 'IT Support', stat_region_focus: 'Region Focus',
    orbit_servers: 'Servers', orbit_cloud: 'Cloud', orbit_security: 'Security', orbit_network: 'Network',
    about_tag: 'Who We Are', about_title2: 'Trusted IT Partner for the Middle East',
    about_p1: 'Founded in 2023 in Cairo, Egypt, InfraConnect provides high-performance IT infrastructure and managed services. We help businesses operate efficiently, scale confidently, and adopt modern technology reliably.',
    about_p2: 'Our vision is to become the premier IT partner in the Middle East — delivering innovative solutions that drive business growth and digital transformation.',
    vision_label: 'Our Vision', mission_label: 'Our Mission',
    vision_text: 'Premier trusted IT partner in the Middle East, driving digital transformation.',
    mission_text: 'Empower businesses with reliable infrastructure, expert support and exceptional quality.',
    contact_region: 'Serving the Middle East region',
    about_card1_title: 'Infrastructure', about_card1_desc: 'Servers, storage, virtualization and structured cabling built for scale.',
    about_card2_title: 'Cloud Services', about_card2_desc: 'Azure, AWS & Oracle deployments with hybrid environment support.',
    about_card3_title: 'Cybersecurity', about_card3_desc: 'Firewalls, endpoint protection, IAM and MDR solutions.',
    about_card4_title: '24/7 Support', about_card4_desc: 'Round-the-clock managed IT with defined SLAs, onsite & remote.',
    services_tag: 'What We Do', services_title: 'Our Services',
    services_sub: 'Three core pillars covering your full IT needs — from physical infrastructure to cloud and continuous operations.',
    svc1_title: 'Infrastructure, Cloud & Networks',
    svc1_desc: 'End-to-end design and deployment of your physical and virtual IT backbone. Servers, storage, structured cabling, LAN/WAN, Wi-Fi, VPN, SD-WAN and cloud migration.',
    svc2_title: 'Cloud Integration & Cyber Resilience',
    svc2_desc: 'Protect your business with enterprise-grade security. 24/7 managed IT, system monitoring, cybersecurity firewalls, endpoint protection, IAM, email security and MDR.',
    svc3_title: 'Managed Services & Operations',
    svc3_desc: 'Keep your business running with proactive support. Backup & disaster recovery, business continuity, IT consulting, infrastructure modernization and authorized IT procurement.',
    store_preview_tag: 'Tech Store', store_preview_title: 'Authorized IT Products',
    store_preview_sub: 'Enterprise hardware and software from leading vendors — competitive pricing, fast delivery and full deployment support.',
    browse_all_products: 'Browse All Products →', loading_categories: 'Loading categories...',
    projects_tag: 'Track Record', projects_title: 'Key Projects',
    projects_sub: 'Real results for real clients — data center modernizations to zero-downtime cloud migrations.',
    proj1_title: 'Money Fellows — Data Center Modernization',
    proj1_li1: 'Modernized full data center: servers, CCTV, network, UPS & redundancy',
    proj1_li2: 'Migrated Google Workspace to Microsoft 365 — zero downtime, zero data loss',
    proj1_li3: 'Developed internal ticketing system and customer support platform',
    proj2_title: 'CoreTech — Network Infrastructure Upgrade',
    proj2_li1: 'Upgraded network infrastructure for improved data center performance',
    proj2_li2: 'Enhanced security with updated CCTV and power protection systems',
    proj2_li3: 'Improved redundancy systems and UPS units for reliable operations',
    proj3_title: 'Carofi — Startup IT Deployment',
    proj3_li1: 'Designed and deployed full IT infrastructure including user devices and servers',
    proj3_li2: 'Secured partnerships leading to a long-term support contract',
    proj3_li3: 'Ensured client satisfaction with consistent IT support',
    advantage_tag: 'Why InfraConnect', advantage_title: 'Our Competitive Advantage',
    adv1: 'Quick response times with well-defined service level agreements',
    adv2: 'Scalable solutions for startups and large enterprises',
    adv3: 'Certified engineers with hands-on field experience',
    adv4: 'Vendor-neutral recommendations prioritizing your value',
    adv5: 'Clear communication and comprehensive reporting',
    contact_tag: 'Get in Touch', contact_title: "Let's Build Your IT Future",
    contact_intro: 'Ready to modernize your infrastructure, migrate to the cloud, or strengthen your cybersecurity? Our team is ready.',
    contact_email_us: 'Email Us', contact_respond_24h: 'We respond within 24 hours',
    contact_call_us: 'Call Us', contact_hq: 'Headquarters',
    footer_tagline_home: 'High-performance IT infrastructure and managed services for businesses in Egypt and the Middle East.',
    footer_company: 'Company', footer_about_us: 'About Us', footer_store: 'Store', footer_all_products: 'All Products',
    footer_contact_col: 'Contact', footer_copyright: '© 2025 InfraConnect. All rights reserved.',
    footer_location: 'Cairo, Egypt — infraconnect24-7.com',
    request_a_service: 'Request a Service', request_service_html: 'Request<br/>Service',
    // About page
    about_hero_tag2: 'About InfraConnect', about_hero_title_html: 'Built to Power <br>the Next Generation',
    about_hero_p: 'Founded in 2023 in Cairo, Egypt, InfraConnect provides high-performance IT infrastructure and managed services to businesses across the Middle East.',
    btn_work_with_us: 'Work With Us', btn_our_services: 'Our Services',
    company_overview_label: 'Company Overview',
    about_stat_founded: 'Founded', about_stat_hq: 'Headquarters', about_stat_projects: 'Projects', about_stat_region: 'Region',
    serving_egypt_uae: '🌍 Serving Egypt, UAE & Middle East',
    about_story_tag: 'Who We Are', about_story_title: 'Our Story',
    about_story_p1: 'InfraConnect was founded with a clear purpose: to bridge the gap between businesses and enterprise-grade technology in the Middle East. We help businesses operate efficiently, scale confidently, and adopt modern technology reliably.',
    about_story_p2: "Our partnerships focus on designing, implementing, and supporting secure, future-ready IT environments — with a long-term commitment to our clients' success.",
    vision_card_text: 'To establish ourselves as a premier and trusted IT partner in the Middle East, providing innovative technology solutions that drive business growth and facilitate digital transformation.',
    mission_card_text: 'To empower businesses by delivering reliable IT infrastructure, expert support, and high-quality technology services — with a priority on optimal performance, strong security, and exceptional quality.',
    team_tag: 'Our Team', team_title: 'Meet the Team',
    team_role_tech: 'Co-Founder & Technical Lead', team_role_biz: 'Co-Founder & Business Development',
    footer_key_projects: 'Key Projects', footer_tagline_about: 'High-performance IT infrastructure and managed services for businesses that want to operate efficiently, scale confidently, and adopt modern technology reliably.',
    cat_wireless: 'Wireless', cat_endpoints: 'Endpoints', cat_power: 'UPS &amp; Power', cairo_egypt: 'Cairo, Egypt',
    // Misc
    lang_switch_label: 'العربية',
  },
  ar: {
    nav_home: 'الرئيسية', nav_about: 'من نحن', nav_services: 'الخدمات', nav_store: 'المتجر',
    nav_projects: 'المشاريع', nav_contact: 'تواصل معنا', nav_request_service: 'اطلب خدمة',
    nav_get_in_touch: 'تواصل معنا', nav_admin: 'الإدارة',
    btn_add_to_cart: 'أضف إلى السلة', btn_add: 'أضف', btn_view_details: 'التفاصيل', btn_view_cart: 'عرض السلة',
    btn_checkout: 'إتمام الشراء', btn_send_message: 'إرسال الرسالة', btn_submit: 'إرسال',
    btn_browse_products: 'تصفح المنتجات', btn_learn_more: 'اعرف المزيد', btn_clear_filters: 'مسح الفلاتر',
    btn_request_quote: 'اطلب عرض سعر', btn_buy_now: 'اشترِ الآن', btn_place_order: 'تأكيد الطلب', btn_continue_shopping: 'متابعة التسوق',
    btn_back: 'رجوع', btn_search: 'بحث',
    store_all_categories: 'كل الفئات', store_search_placeholder: 'ابحث عن منتجات…',
    store_no_products: 'لا توجد منتجات', store_price_on_request: 'السعر عند الطلب',
    out_of_stock: 'نفدت الكمية', only_x_left: 'تبقى {n} فقط!',
    reviews_title: 'آراء العملاء', reviews_loading: 'جارٍ تحميل التقييمات...',
    btn_write_review: 'اكتب تقييماً', reviews_write_title: 'شاركنا تجربتك',
    reviews_your_rating: 'تقييمك', reviews_email_optional: 'البريد الإلكتروني (اختياري، لا يُعرض للعامة)',
    reviews_your_comment: 'تقييمك المكتوب', btn_submit_review: 'إرسال التقييم', btn_cancel: 'إلغاء',
    reviews_one: 'تقييم', reviews_many: 'تقييمات', reviews_none_yet: 'لا توجد تقييمات بعد — كن أول من يقيّم!',
    store_related_products: 'منتجات ذات صلة', store_specifications: 'المواصفات',
    store_brand: 'الماركة', store_category: 'الفئة',
    cart_title: 'سلة التسوق', cart_empty: 'سلتك فارغة', cart_subtotal: 'المجموع الفرعي',
    cart_total: 'الإجمالي', cart_quantity: 'الكمية', cart_remove: 'إزالة',
    checkout_title: 'إتمام الشراء', checkout_your_details: 'بياناتك',
    checkout_first_name: 'الاسم الأول', checkout_last_name: 'اسم العائلة',
    checkout_email: 'البريد الإلكتروني', checkout_phone: 'رقم الهاتف', checkout_company: 'الشركة (اختياري)',
    checkout_notes: 'ملاحظات إضافية (اختياري)',
    form_first_name: 'الاسم الأول', form_last_name: 'اسم العائلة', form_email: 'البريد الإلكتروني',
    form_phone: 'رقم الهاتف', form_company: 'الشركة', form_message: 'الرسالة',
    form_service_needed: 'الخدمة المطلوبة', form_send_us_message: 'أرسل لنا رسالة',
    footer_quick_links: 'روابط سريعة', footer_contact_us: 'تواصل معنا', footer_follow_us: 'تابعنا',
    admin_sec_overview: 'نظرة عامة', admin_sec_website: 'محتوى الموقع', admin_sec_store: 'المتجر',
    admin_sec_crm: 'إدارة العملاء', admin_sec_settings: 'الإعدادات',
    admin_dashboard: 'لوحة التحكم', admin_analytics: 'التحليلات', admin_site_editor: 'محرر الموقع', admin_pages: 'الصفحات',
    admin_navigation: 'قائمة التنقل', admin_media: 'الوسائط والشعارات', admin_ai_creator: '✨ منشئ المنتجات بالذكاء الاصطناعي',
    admin_products: 'المنتجات', admin_categories: 'الفئات', admin_reviews: 'التقييمات والمراجعات', admin_vouchers: 'القسائم والخصومات', admin_service_requests: 'طلبات الخدمة',
    admin_messages: 'الرسائل', admin_quotes: 'عروض الأسعار', admin_orders: 'الطلبات', admin_chat: 'الدردشة', admin_customers: 'العملاء', admin_refunds: 'طلبات الاسترجاع', admin_couriers: 'مندوبو التوصيل',
    admin_company_info: 'معلومات الشركة', admin_seo_settings: 'إعدادات السيو', admin_users: 'مستخدمو الإدارة', admin_api_console: 'وحدة تحكم API', admin_activity_log: 'سجل النشاط',
    admin_sign_out: 'تسجيل الخروج', admin_view_website: '↗ عرض الموقع', admin_view_store: '↗ عرض المتجر',
    home_hero_tag: 'خبراء البنية التحتية التقنية — القاهرة، مصر',
    home_hero_title_html: 'نبني بنية تحتية تقنية <em>جاهزة للمستقبل</em>',
    home_hero_sub: 'تقدم إنفراكونكت بنية تحتية تقنية عالية الأداء، وخدمات سحابية، ودعماً تقنياً مُدارًا للشركات التي ترفض التوقف عن التطور.',
    stat_founded: 'التأسيس', stat_key_projects: 'مشاريع رئيسية', stat_it_support: 'دعم تقني', stat_region_focus: 'التركيز الإقليمي',
    orbit_servers: 'خوادم', orbit_cloud: 'سحابة', orbit_security: 'أمان', orbit_network: 'شبكة',
    about_tag: 'من نحن', about_title2: 'شريكك التقني الموثوق في الشرق الأوسط',
    about_p1: 'تأسست إنفراكونكت عام 2023 في القاهرة، مصر، وتقدم بنية تحتية تقنية عالية الأداء وخدمات مُدارة. نساعد الشركات على العمل بكفاءة، والتوسع بثقة، وتبني التقنيات الحديثة بشكل موثوق.',
    about_p2: 'رؤيتنا أن نصبح الشريك التقني الأول في الشرق الأوسط — من خلال تقديم حلول مبتكرة تدفع نمو الأعمال والتحول الرقمي.',
    vision_label: 'رؤيتنا', mission_label: 'مهمتنا',
    vision_text: 'الشريك التقني الموثوق الأول في الشرق الأوسط، ودافع رئيسي للتحول الرقمي.',
    mission_text: 'تمكين الشركات ببنية تحتية موثوقة، ودعم متخصص، وجودة استثنائية.',
    contact_region: 'نخدم منطقة الشرق الأوسط',
    about_card1_title: 'البنية التحتية', about_card1_desc: 'خوادم، وحدات تخزين، أنظمة افتراضية، وأسلاك بنية منظمة مصممة للتوسع.',
    about_card2_title: 'الخدمات السحابية', about_card2_desc: 'نشر حلول Azure وAWS وOracle مع دعم البيئات الهجينة.',
    about_card3_title: 'الأمن السيبراني', about_card3_desc: 'جدران حماية، حماية نقاط النهاية، إدارة الهويات، وحلول MDR.',
    about_card4_title: 'دعم على مدار الساعة', about_card4_desc: 'إدارة تقنية معلومات على مدار الساعة باتفاقيات مستوى خدمة محددة، ميدانياً وعن بُعد.',
    services_tag: 'ماذا نقدم', services_title: 'خدماتنا',
    services_sub: 'ثلاثة محاور أساسية تغطي كل احتياجاتك التقنية — من البنية التحتية الفعلية إلى السحابة والعمليات المستمرة.',
    svc1_title: 'البنية التحتية والحوسبة السحابية والشبكات',
    svc1_desc: 'تصميم ونشر شامل لبنيتك التحتية التقنية الفعلية والافتراضية. خوادم، تخزين، أسلاك بنية منظمة، شبكات محلية وواسعة، واي فاي، VPN، SD-WAN، وترحيل إلى السحابة.',
    svc2_title: 'التكامل السحابي والمرونة السيبرانية',
    svc2_desc: 'احمِ أعمالك بأمان بمستوى المؤسسات. إدارة تقنية معلومات على مدار الساعة، مراقبة الأنظمة، جدران حماية، حماية نقاط النهاية، إدارة الهويات، أمان البريد الإلكتروني، وخدمة MDR.',
    svc3_title: 'الخدمات المُدارة والعمليات',
    svc3_desc: 'حافظ على استمرارية عملك بدعم استباقي. نسخ احتياطي وتعافي من الكوارث، استمرارية الأعمال، استشارات تقنية، تحديث البنية التحتية، وتوريد معتمد.',
    store_preview_tag: 'المتجر التقني', store_preview_title: 'منتجات تقنية معتمدة',
    store_preview_sub: 'أجهزة وبرمجيات مؤسسية من كبرى الشركات المصنعة — أسعار تنافسية، توصيل سريع، ودعم كامل للتركيب.',
    browse_all_products: 'تصفح جميع المنتجات ←', loading_categories: 'جارٍ تحميل الفئات...',
    projects_tag: 'سجل الإنجازات', projects_title: 'أبرز المشاريع',
    projects_sub: 'نتائج حقيقية لعملاء حقيقيين — من تحديث مراكز البيانات إلى الترحيل السحابي بدون توقف.',
    proj1_title: 'Money Fellows — تحديث مركز البيانات',
    proj1_li1: 'تحديث كامل لمركز البيانات: خوادم، كاميرات مراقبة، شبكات، أنظمة UPS والتكرار',
    proj1_li2: 'ترحيل Google Workspace إلى Microsoft 365 — بدون توقف وبدون فقدان بيانات',
    proj1_li3: 'تطوير نظام تذاكر داخلي ومنصة دعم العملاء',
    proj2_title: 'CoreTech — تطوير البنية التحتية للشبكة',
    proj2_li1: 'تطوير البنية التحتية للشبكة لتحسين أداء مركز البيانات',
    proj2_li2: 'تعزيز الأمان بأنظمة مراقبة وحماية طاقة محدثة',
    proj2_li3: 'تحسين أنظمة التكرار ووحدات UPS لعمليات موثوقة',
    proj3_title: 'Carofi — نشر تقني لشركة ناشئة',
    proj3_li1: 'تصميم ونشر بنية تحتية تقنية كاملة تشمل أجهزة المستخدمين والخوادم',
    proj3_li2: 'تأمين شراكات أدت إلى عقد دعم طويل الأمد',
    proj3_li3: 'ضمان رضا العميل من خلال دعم تقني مستمر',
    advantage_tag: 'لماذا إنفراكونكت', advantage_title: 'مزايانا التنافسية',
    adv1: 'استجابة سريعة باتفاقيات مستوى خدمة محددة بوضوح',
    adv2: 'حلول قابلة للتوسع للشركات الناشئة والمؤسسات الكبرى',
    adv3: 'مهندسون معتمدون بخبرة ميدانية عملية',
    adv4: 'توصيات محايدة تجاه الموردين تُقدّم قيمتك أولاً',
    adv5: 'تواصل واضح وتقارير شاملة',
    contact_tag: 'تواصل معنا', contact_title: 'لنبني مستقبلك التقني معاً',
    contact_intro: 'مستعد لتحديث بنيتك التحتية، أو الانتقال إلى السحابة، أو تعزيز أمنك السيبراني؟ فريقنا جاهز.',
    contact_email_us: 'راسلنا عبر البريد', contact_respond_24h: 'نرد خلال 24 ساعة',
    contact_call_us: 'اتصل بنا', contact_hq: 'المقر الرئيسي',
    footer_tagline_home: 'بنية تحتية تقنية عالية الأداء وخدمات مُدارة للشركات في مصر والشرق الأوسط.',
    footer_company: 'الشركة', footer_about_us: 'من نحن', footer_store: 'المتجر', footer_all_products: 'جميع المنتجات',
    footer_contact_col: 'تواصل', footer_copyright: '© 2025 إنفراكونكت. جميع الحقوق محفوظة.',
    footer_location: 'القاهرة، مصر — infraconnect24-7.com',
    request_a_service: 'اطلب خدمة', request_service_html: 'اطلب<br/>خدمة',
    about_hero_tag2: 'عن إنفراكونكت', about_hero_title_html: 'بُنيت لتشغيل <br>الجيل القادم',
    about_hero_p: 'تأسست إنفراكونكت عام 2023 في القاهرة، مصر، وتقدم بنية تحتية تقنية عالية الأداء وخدمات مُدارة للشركات في جميع أنحاء الشرق الأوسط.',
    btn_work_with_us: 'اعمل معنا', btn_our_services: 'خدماتنا',
    company_overview_label: 'نظرة عامة على الشركة',
    about_stat_founded: 'التأسيس', about_stat_hq: 'المقر الرئيسي', about_stat_projects: 'المشاريع', about_stat_region: 'المنطقة',
    serving_egypt_uae: '🌍 نخدم مصر والإمارات والشرق الأوسط',
    about_story_tag: 'من نحن', about_story_title: 'قصتنا',
    about_story_p1: 'تأسست إنفراكونكت بهدف واضح: سد الفجوة بين الشركات والتقنيات المؤسسية في الشرق الأوسط. نساعد الشركات على العمل بكفاءة، والتوسع بثقة، وتبني التقنيات الحديثة بشكل موثوق.',
    about_story_p2: 'تركز شراكاتنا على تصميم وتنفيذ ودعم بيئات تقنية آمنة وجاهزة للمستقبل — مع التزام طويل الأمد بنجاح عملائنا.',
    vision_card_text: 'أن نصبح الشريك التقني الموثوق والرائد في الشرق الأوسط، من خلال تقديم حلول تقنية مبتكرة تدفع نمو الأعمال وتُسهّل التحول الرقمي.',
    mission_card_text: 'تمكين الشركات من خلال تقديم بنية تحتية تقنية موثوقة، ودعم متخصص، وخدمات تقنية عالية الجودة — مع إعطاء الأولوية للأداء الأمثل، والأمان القوي، والجودة الاستثنائية.',
    team_tag: 'فريقنا', team_title: 'تعرّف على الفريق',
    team_role_tech: 'شريك مؤسس وقائد تقني', team_role_biz: 'شريك مؤسس وتطوير الأعمال',
    footer_key_projects: 'أبرز المشاريع', footer_tagline_about: 'بنية تحتية تقنية عالية الأداء وخدمات مُدارة للشركات التي تريد العمل بكفاءة والتوسع بثقة وتبني التقنيات الحديثة بشكل موثوق.',
    cat_wireless: 'الشبكات اللاسلكية', cat_endpoints: 'نقاط النهاية', cat_power: 'الطاقة الاحتياطية', cairo_egypt: 'القاهرة، مصر',
    lang_switch_label: 'English',
  }
};

/* ── Core helpers ─────────────────────────────────────────────────────── */
function icGetLang() {
  return localStorage.getItem(IC_LANG_KEY) || 'en';
}

function icSetLang(lang) {
  localStorage.setItem(IC_LANG_KEY, lang);
  // A full reload is the simplest reliable way to re-render every dynamic
  // list (product grids, cart, admin tables) in the new language without
  // having to duplicate every render function's logic for a live-swap.
  window.location.reload();
}

function icT(key) {
  const lang = icGetLang();
  return (IC_I18N[lang] && IC_I18N[lang][key]) || IC_I18N.en[key] || key;
}

// Returns the Arabic version of a field (e.g. localized(product, 'name'))
// when Arabic is active AND a translation exists, otherwise falls back to
// the English field. Safe to call even if the _ar field is null/empty.
function localized(obj, field) {
  if (!obj) return '';
  if (icGetLang() === 'ar') {
    const arVal = obj[field + '_ar'];
    if (arVal !== undefined && arVal !== null && String(arVal).trim() !== '') return arVal;
  }
  return obj[field];
}

function icApplyDocumentDirection(lang) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.body.classList.toggle('lang-ar', lang === 'ar');
}

function icApplyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = icT(el.getAttribute('data-i18n'));
  });
  // Only ever use data-i18n-html with keys from this dictionary above —
  // never with user-submitted content (that stays on escHtml + textContent
  // per the SEC-02 fix elsewhere in the app).
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = icT(el.getAttribute('data-i18n-html'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = icT(el.getAttribute('data-i18n-placeholder'));
  });
}

/* ── Language switcher UI — renders into the navbar slot every page/admin
   layout now has (a #ic-lang-switch-slot button placed next to the other
   nav buttons), styled to match the site's existing nav buttons. ── */
function icInjectSwitcher() {
  const slot = document.getElementById('ic-lang-switch-slot');
  if (!slot) return;
  const lang = icGetLang();
  slot.textContent = lang === 'ar' ? 'English' : 'العربية';
  slot.setAttribute('aria-label', 'Switch language / تبديل اللغة');
  slot.onclick = () => icSetLang(lang === 'ar' ? 'en' : 'ar');

  if (!document.getElementById('ic-lang-switch-style')) {
    const style = document.createElement('style');
    style.id = 'ic-lang-switch-style';
    style.textContent = `
      .ic-nav-lang-btn {
        display: inline-flex; align-items: center; justify-content: center;
        background: var(--blue-light, #eaf0fe); color: var(--blue, #1a56db);
        border: 1.5px solid var(--blue, #1a56db); border-radius: 8px;
        padding: 7px 14px; font-size: 13px; font-weight: 700;
        font-family: 'Inter', 'Cairo', sans-serif; cursor: pointer;
        transition: background 0.15s, color 0.15s; white-space: nowrap;
        margin-inline-end: 8px;
      }
      .ic-nav-lang-btn:hover { background: var(--blue, #1a56db); color: #fff; }
      body.lang-ar { font-family: 'Cairo', 'Inter', sans-serif; }
      body.lang-ar h1, body.lang-ar h2, body.lang-ar h3, body.lang-ar h4, body.lang-ar h5 { font-family: 'Cairo', 'Inter', sans-serif; }
    `;
    document.head.appendChild(style);
  }
}

function icInit() {
  icApplyDocumentDirection(icGetLang());
  icApplyTranslations();
  icInjectSwitcher();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', icInit);
} else {
  icInit();
}
